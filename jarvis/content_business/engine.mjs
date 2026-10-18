/**
 * content_business/engine.mjs
 * 出版事業部 半自動フローエンジン
 *
 * - semi_auto_flow.json の状態遷移に従って処理を実行
 * - 社長承認が必要なステップで必ず停止
 * - 外部公開・送信は絶対に自動実行しない
 * - エラー時は1回だけ自動リトライ、2回失敗でERROR表示
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetDisabledError, BudgetExceededError } from '../shared/claude_router.mjs';
import { applyJobEvent } from './relationship_manager.mjs';
import { logEvent }      from './story_logger.mjs';
import {
  runScout, runScreening, runAnalyst, runPlanner,
  runWriter, runWriterRevision, runEditor, runGrowth,
  runEmployeeChat, runEditorialMeeting,
  runWriterFromChat,
  runKotoriSeriesPlanner,
  runOwnerReviewJudge, runEditorMinorRevision, runWriterMajorRevision,
  runFactCheckPresentation, runDirectPlanProposal,
  runIdeaFactCheck, runIdeaOutlinePlanner,
  runLearningsExtractor,
  runMetricsAnalysis,
} from './ai_worker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW_PATH = resolve(__dirname, '../workflows/semi_auto_flow.json');
const PERSONALITIES_PATH = resolve(__dirname, '../config/employee_personalities.json');

let _flow = null;
function getFlow() {
  if (!_flow) _flow = JSON.parse(readFileSync(FLOW_PATH, 'utf8'));
  return _flow;
}

let _personalities = null;
function getPersonalities() {
  if (!_personalities) {
    try { _personalities = JSON.parse(readFileSync(PERSONALITIES_PATH, 'utf8')); }
    catch (_) { _personalities = {}; }
  }
  return _personalities;
}

/**
 * 社員・ステータス・プロジェクト文脈からメッセージを選ぶ
 * 1分ごとにインデックスが変わり、自然なバリエーションを生む
 */
function pickEmployeeMessage(empId, empStatus, projectLabel) {
  const p = getPersonalities()[empId];
  if (!p) return null;
  const msgs = p.messages?.[empStatus];
  if (!msgs || msgs.length === 0) return null;
  const idx = Math.floor(Date.now() / 90000) % msgs.length; // ~1.5分ごとに変化
  return msgs[idx].replace('{project_label}', projectLabel || 'このプロジェクト');
}

const MAX_RETRIES = 1;

/** ジョブレコードを作成して返す */
function createJob(db, projectId, jobType, payloadJson = null) {
  const stmt = db.prepare(`
    INSERT INTO cb_jobs (project_id, job_type, status, payload_json, created_at)
    VALUES (?, ?, 'PENDING', ?, datetime('now','localtime'))
  `);
  const result = stmt.run(projectId, jobType, payloadJson ? JSON.stringify(payloadJson) : null);
  return result.lastInsertRowid;
}

/** ジョブステータスを更新 */
function updateJobStatus(db, jobId, status, { resultJson = null, errorMessage = null, retryCount = null } = {}) {
  const fields = ['status = ?'];
  const vals = [status];

  if (status === 'RUNNING') {
    fields.push("started_at = datetime('now','localtime')");
  }
  if (status === 'DONE' || status === 'ERROR') {
    fields.push("finished_at = datetime('now','localtime')");
  }
  if (resultJson !== null) {
    fields.push('result_json = ?');
    vals.push(typeof resultJson === 'string' ? resultJson : JSON.stringify(resultJson));
  }
  if (errorMessage !== null) {
    fields.push('error_message = ?');
    vals.push(errorMessage);
  }
  if (retryCount !== null) {
    fields.push('retry_count = ?');
    vals.push(retryCount);
  }

  vals.push(jobId);
  db.prepare(`UPDATE cb_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

/** プロジェクトステータスを更新 */
function updateProjectStatus(db, projectId, status, extra = {}) {
  const fields = ["status = ?", "updated_at = datetime('now','localtime')"];
  const vals = [status];

  if (extra.researchCount !== undefined) {
    fields.push('research_count = ?');
    vals.push(extra.researchCount);
  }
  if (extra.revisionCount !== undefined) {
    fields.push('revision_count = ?');
    vals.push(extra.revisionCount);
  }

  vals.push(projectId);
  db.prepare(`UPDATE cb_projects SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * ジョブを実行（リトライ付き）
 */
async function runJobWithRetry(db, projectId, jobType, execFn) {
  const jobId = createJob(db, projectId, jobType);
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      updateJobStatus(db, jobId, 'RUNNING', { retryCount: attempt });
      await new Promise(r => setTimeout(r, 2000)); // リトライ前2秒待機
    } else {
      updateJobStatus(db, jobId, 'RUNNING');
    }

    try {
      const result = await execFn();
      updateJobStatus(db, jobId, 'DONE', { resultJson: result });
      return { jobId, result };
    } catch (err) {
      // 予算エラーはリトライしない（再試行しても予算は回復しないため）
      if (err instanceof BudgetDisabledError || err instanceof BudgetExceededError) {
        updateJobStatus(db, jobId, 'ERROR', {
          errorMessage: err.message,
          retryCount: 0,
        });
        throw err;
      }
      lastError = err;
      console.error(`[CB Engine] ${jobType} 試行${attempt + 1}失敗:`, err.message);
    }
  }

  // 全リトライ失敗
  updateJobStatus(db, jobId, 'ERROR', {
    errorMessage: lastError?.message ?? '不明なエラー',
    retryCount: MAX_RETRIES,
  });
  throw lastError;
}

/**
 * プロジェクト作成
 */
export function createProject(db, { theme, genre, targetReader, priceRange, researchMode = 'LIGHT', seriesId = null, seriesOrder = null }) {
  const stmt = db.prepare(`
    INSERT INTO cb_projects
      (theme, genre, target_reader, price_range, status, research_mode, series_id, series_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'RESEARCH', ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
  `);
  const result = stmt.run(
    theme || null, genre || null, targetReader || null, priceRange || null,
    researchMode, seriesId || null, seriesOrder || null
  );
  return result.lastInsertRowid;
}

/**
 * RESEARCH フェーズ実行
 * Scout が市場調査データを構造化する
 */
/** RESEARCH フェーズの全体タイムアウト */
const RESEARCH_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;  // FULL: 10分
const LIGHT_MAX_URLS     = 5;
const LIGHT_TIMEOUT_MS   = 2 * 60 * 1000;           // LIGHT: 2分

export async function runResearch(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) throw new Error(`プロジェクトが見つかりません: ${projectId}`);

  const researchMode    = project.research_mode ?? 'LIGHT';
  const isLight         = researchMode === 'LIGHT';
  const maxUrls         = isLight ? LIGHT_MAX_URLS : 30;
  const totalTimeoutMs  = isLight ? LIGHT_TIMEOUT_MS : RESEARCH_TOTAL_TIMEOUT_MS;

  updateProjectStatus(db, projectId, 'RESEARCH');

  // 既存の手動登録URLを取得
  const existingItems = db.prepare('SELECT url FROM cb_research_items WHERE project_id = ? AND url IS NOT NULL').all(projectId);
  const existingUrls = existingItems.map(r => r.url).filter(Boolean);

  // 手動URLが未登録の場合: スクリーニング → URL自動探索の順で実行
  let screeningTopics = [];
  if (existingUrls.length === 0) {
    console.log(`[RESEARCH] 手動URL未登録 → スクリーニングを実行します（モード: ${researchMode}）`);
    try {
      const { topSeeds } = await runScreening({
        theme: project.theme,
        genre: project.genre,
      });
      screeningTopics = topSeeds.flatMap(s => s.queries ?? [s.title.slice(0, 20)]);
      console.log(`[RESEARCH] スクリーニング完了: 上位${topSeeds.length}案 → クエリ: ${screeningTopics.join(' / ')}`);
      updateProjectStatus(db, projectId, 'RESEARCH');
    } catch (err) {
      console.warn('[RESEARCH] スクリーニングエラー（スキップ）:', err.message);
    }
  }

  // 全体タイムアウト付きで実行
  let _timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    _timeoutHandle = setTimeout(() => {
      reject(new Error(`RESEARCH_TIMEOUT: 調査が${isLight ? '2' : '10'}分を超えたため中断しました。`));
    }, totalTimeoutMs);
  });

  let jobResult;
  try {
    jobResult = await Promise.race([
      runJobWithRetry(db, projectId, 'RESEARCH', async () => {
        return await runScout({
          theme: project.theme,
          genre: project.genre,
          targetReader: project.target_reader,
          priceRange: project.price_range,
          existingUrls,
          screeningTopics,
          maxUrls,
          lightMode: isLight,
        });
      }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(_timeoutHandle);
  }

  const { jobId, result } = jobResult;

  // LIGHT モードで URL が 1 件も取得できなかった場合: ERROR にせず RESEARCH のまま返す
  if (result.noResults) {
    console.warn(`[RESEARCH] LIGHT モードで取得件数0件 → noResults で返します（プロジェクト #${projectId}）`);
    return { jobId, noResults: true, mode: researchMode };
  }

  // 結果をDB保存
  if (result.items && Array.isArray(result.items)) {
    const insertItem = db.prepare(`
      INSERT OR REPLACE INTO cb_research_items
        (project_id, url, title, author, price, published_at, target_reader,
         problem_solved, free_content, table_of_contents, cta, reaction_metrics, notes,
         source, fetch_ok, fetch_error, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of result.items) {
      insertItem.run(
        projectId,
        item.url        || null,
        item.title      || null,
        item.author     || null,
        item.price      || null,
        item.published_at || null,
        item.target_reader  || null,
        item.problem_solved || null,
        item.free_content   || null,
        item.table_of_contents || null,
        item.cta            || null,
        item.reaction_metrics || null,
        item.notes          || null,
        item.source         || null,
        item.fetch_ok === false ? 0 : 1,
        item.fetch_error    || null,
        item.fetched_at     || null
      );
    }
    const successCount = result.items.filter(i => i.fetch_ok !== false).length;
    updateProjectStatus(db, projectId, 'ANALYSIS', { researchCount: successCount });
  }

  // P42-B + P43-A: 調査完了・引き継ぎ（setImmediate で非同期 / 業務フロー非ブロック）
  setImmediate(() => {
    logEvent(db, {
      eventType:   'BUSINESS_HANDOFF',
      fromEmp:     'Scout',
      toEmp:       'Analyst',
      contentText: `ヒカゲが市場調査を完了した。テーマ「${project.theme ?? '（未設定）'}」、取得件数${successCount}件。ヒノデへデータを引き継ぐ。`,
      sourceType:  'cb_jobs',
      sourceId:    jobId,
    });
    applyJobEvent(db, 'research_handoff', { fromEmp: 'Scout', toEmp: 'Analyst', jobId, projectId });
  });

  return { jobId, lowSample: result.low_sample, count: result.count, fetchSummary: result.fetch_summary, mode: researchMode };
}

/**
 * NONE モード専用: 外部調査なしで直接企画案を生成する（kotoriシリーズ用）
 * RESEARCH → IDEA_REVIEW → OWNER_IDEA_APPROVAL（停止）
 */
export async function runNoneIdeaReview(db, projectId) {
  updateProjectStatus(db, projectId, 'IDEA_REVIEW');
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);

  // 同シリーズの既存記事一覧（重複防止用）
  let existingArticles = [];
  if (project.series_id) {
    existingArticles = db.prepare(`
      SELECT p.id, p.theme, p.status,
        (SELECT title_candidates FROM cb_article_drafts WHERE project_id = p.id ORDER BY version DESC LIMIT 1) AS title_json
      FROM cb_projects p
      WHERE p.series_id = ? AND p.id != ? AND p.deleted_at IS NULL
    `).all(project.series_id, projectId).map(r => ({
      id:     r.id,
      theme:  r.theme,
      status: r.status,
      title:  (() => { try { return JSON.parse(r.title_json)?.[0] ?? r.theme; } catch { return r.theme; } })(),
    }));
  }

  const { jobId, result } = await runJobWithRetry(db, projectId, 'IDEA_REVIEW', async () => {
    return await runKotoriSeriesPlanner({ theme: project.theme, existingArticles });
  });

  // アイデアをDB保存
  if (result.ideas && Array.isArray(result.ideas)) {
    const insertIdea = db.prepare(`
      INSERT INTO cb_ideas
        (project_id, idea_index, title, target_reader, problem, value, uniqueness,
         rationale, structure, price_range, workload, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const idea of result.ideas) {
      insertIdea.run(
        projectId, idea.index ?? 0,
        idea.title || null, idea.target_reader || null, idea.problem || null,
        idea.value || null, idea.uniqueness || null, idea.rationale || null,
        idea.structure || null, idea.price_range || null, idea.workload || null,
        JSON.stringify(idea)
      );
    }
  }

  updateProjectStatus(db, projectId, 'OWNER_IDEA_APPROVAL');
  return { jobId, ideas: result.ideas };
}

/**
 * ANALYSIS フェーズ実行
 * Analyst が市場構造を分析する
 */
export async function runAnalysis(db, projectId) {
  updateProjectStatus(db, projectId, 'ANALYSIS');
  const items = db.prepare('SELECT * FROM cb_research_items WHERE project_id = ?').all(projectId);
  const lowSample = items.length < 10;

  const { jobId, result } = await runJobWithRetry(db, projectId, 'ANALYSIS', async () => {
    return await runAnalyst({ items, lowSample });
  });

  updateProjectStatus(db, projectId, 'IDEA_REVIEW');

  // P42-B + P43-A: 分析完了・引き継ぎ
  setImmediate(() => {
    const _proj = db.prepare('SELECT theme FROM cb_projects WHERE id=?').get(projectId);
    logEvent(db, {
      eventType:   'BUSINESS_HANDOFF',
      fromEmp:     'Analyst',
      toEmp:       'Planner',
      contentText: `ヒノデが市場分析を完了した。テーマ「${_proj?.theme ?? '（未設定）'}」。アサヒへ分析レポートを引き継ぐ。${lowSample ? '（サンプル数が不足している）' : ''}`,
      sourceType:  'cb_jobs',
      sourceId:    jobId,
    });
    applyJobEvent(db, 'analysis_handoff', { fromEmp: 'Analyst', toEmp: 'Planner', jobId, projectId });
  });

  return { jobId, analysis: result, lowSample };
}

/**
 * IDEA_REVIEW フェーズ実行
 * Planner が商品候補3案を生成する
 */
export async function runIdeaReview(db, projectId, analysisResult) {
  updateProjectStatus(db, projectId, 'IDEA_REVIEW');
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);

  const { jobId, result } = await runJobWithRetry(db, projectId, 'IDEA_REVIEW', async () => {
    return await runPlanner({
      analysis: analysisResult,
      theme: project.theme,
      genre: project.genre,
      targetReader: project.target_reader,
      priceRange: project.price_range,
    });
  });

  // アイデアをDB保存
  if (result.ideas && Array.isArray(result.ideas)) {
    const insertIdea = db.prepare(`
      INSERT INTO cb_ideas
        (project_id, idea_index, title, target_reader, problem, value, uniqueness,
         rationale, structure, price_range, workload, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const idea of result.ideas) {
      insertIdea.run(
        projectId, idea.index ?? 0,
        idea.title || null, idea.target_reader || null, idea.problem || null,
        idea.value || null, idea.uniqueness || null, idea.rationale || null,
        idea.structure || null, idea.price_range || null, idea.workload || null,
        JSON.stringify(idea)
      );
    }
  }

  // OWNER_IDEA_APPROVAL で停止（社長確認待ち）
  updateProjectStatus(db, projectId, 'OWNER_IDEA_APPROVAL');
  return { jobId, ideas: result.ideas };
}

/**
 * WRITING フェーズ実行
 * Writer が記事を執筆する
 */
export async function runWriting(db, projectId, revisionRequest = null) {
  updateProjectStatus(db, projectId, 'WRITING');
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  const selectedIdea = db.prepare(
    'SELECT * FROM cb_ideas WHERE project_id = ? AND idea_index = ?'
  ).get(projectId, project.selected_idea_index ?? 1);

  if (!selectedIdea) throw new Error('採用案が選択されていません');

  const ideaData = selectedIdea.raw_json ? JSON.parse(selectedIdea.raw_json) : selectedIdea;

  const knowledge = loadApprovedKnowledge(db);
  const { jobId, result } = await runJobWithRetry(db, projectId, 'WRITING', async () => {
    return await runWriter({ selectedIdea: ideaData, revisionRequest, approvedKnowledge: knowledge });
  });

  // 最新バージョン番号を取得
  const lastDraft = db.prepare(
    'SELECT MAX(version) as max_v FROM cb_article_drafts WHERE project_id = ?'
  ).get(projectId);
  const newVersion = (lastDraft?.max_v ?? 0) + 1;

  // ドラフト保存
  db.prepare(`
    INSERT INTO cb_article_drafts
      (project_id, version, title_candidates, lead, free_part, paid_part, summary, revision_request)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, newVersion,
    JSON.stringify(result.title_candidates ?? []),
    result.lead || null, result.free_part || null,
    result.paid_part || null, result.summary || null,
    revisionRequest || null
  );

  updateProjectStatus(db, projectId, 'EDITING');

  // P42-B + P43-A: 企画確定・執筆依頼
  setImmediate(() => {
    const _title = ideaData?.title ?? project.theme ?? '（タイトル未定）';
    logEvent(db, {
      eventType:   'BUSINESS_HANDOFF',
      fromEmp:     'Planner',
      toEmp:       'Writer',
      contentText: `アサヒの企画案が確定した。タイトル案「${_title}」でソラへ執筆依頼が出された。`,
      sourceType:  'cb_jobs',
      sourceId:    jobId,
    });
    applyJobEvent(db, 'writing_handoff', { fromEmp: 'Planner', toEmp: 'Writer', jobId, projectId });
  });

  return { jobId, version: newVersion };
}

/**
 * EDITING フェーズ実行
 * Editor が原稿をチェックする
 */
export async function runEditing(db, projectId) {
  updateProjectStatus(db, projectId, 'EDITING');
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);

  const latestDraft = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  if (!latestDraft) throw new Error('原稿ドラフトが見つかりません');

  const selectedIdea = db.prepare(
    'SELECT * FROM cb_ideas WHERE project_id = ? AND idea_index = ?'
  ).get(projectId, project.selected_idea_index ?? 1);
  const ideaData = selectedIdea?.raw_json ? JSON.parse(selectedIdea.raw_json) : selectedIdea;

  const draftData = {
    title_candidates: latestDraft.title_candidates ? JSON.parse(latestDraft.title_candidates) : [],
    lead: latestDraft.lead,
    free_part: latestDraft.free_part,
    paid_part: latestDraft.paid_part,
    summary: latestDraft.summary,
  };

  const knowledge = loadApprovedKnowledge(db);
  const { jobId, result } = await runJobWithRetry(db, projectId, 'EDITING', async () => {
    return await runEditor({ draft: draftData, selectedIdea: ideaData, approvedKnowledge: knowledge });
  });

  // ドラフトに編集結果を記録（有料適性判定も含む）
  db.prepare(`
    UPDATE cb_article_drafts
    SET editor_verdict = ?, editor_notes = ?, revision_request = ?,
        price_type = ?, paid_appropriateness = ?, paid_appropriateness_reason = ?
    WHERE id = ?
  `).run(
    result.verdict,
    result.notes,
    result.revision_request || null,
    result.price_type || null,
    result.paid_appropriateness || null,
    result.paid_appropriateness_reason || null,
    latestDraft.id
  );

  const config = JSON.parse(readFileSync(resolve(__dirname, '../config/content_business.json'), 'utf8'));
  const maxRevisions = config.generation?.max_auto_revisions ?? 2;

  if (result.verdict === 'READY') {
    // APPROVAL_WAIT で停止（社長確認待ち）
    updateProjectStatus(db, projectId, 'APPROVAL_WAIT');
    // P42-B + P43-A: READY判定
    setImmediate(() => {
      logEvent(db, {
        eventType:   'BUSINESS_HANDOFF',
        fromEmp:     'Writer',
        toEmp:       'Editor',
        contentText: `キイロがソラの原稿をREADYと判定した。テーマ「${project.theme ?? ''}」。承認待ちへ移行。`,
        sourceType:  'cb_jobs',
        sourceId:    jobId,
      });
      applyJobEvent(db, 'editing_ready', { fromEmp: 'Writer', toEmp: 'Editor', jobId, projectId });
    });
    return { jobId, verdict: 'READY', nextStatus: 'APPROVAL_WAIT' };
  }

  if (result.verdict === 'BLOCKED') {
    updateProjectStatus(db, projectId, 'NEEDS_HUMAN_REVIEW');
    // P42-B + P43-A: BLOCKED判定
    setImmediate(() => {
      logEvent(db, {
        eventType:   'BUSINESS_HANDOFF',
        fromEmp:     'Writer',
        toEmp:       'Editor',
        contentText: `キイロがソラの原稿をBLOCKEDと判定した。テーマ「${project.theme ?? ''}」。人間によるレビューが必要。`,
        sourceType:  'cb_jobs',
        sourceId:    jobId,
      });
      applyJobEvent(db, 'editing_blocked', { fromEmp: 'Writer', toEmp: 'Editor', jobId, projectId });
    });
    return { jobId, verdict: 'BLOCKED', nextStatus: 'NEEDS_HUMAN_REVIEW' };
  }

  // REVISION_REQUIRED
  if (project.revision_count >= maxRevisions) {
    // 最大修正回数超過
    updateProjectStatus(db, projectId, 'NEEDS_HUMAN_REVIEW');
    // P42-B + P43-A: REVISION（最大回数超過）
    setImmediate(() => {
      logEvent(db, {
        eventType:   'BUSINESS_HANDOFF',
        fromEmp:     'Writer',
        toEmp:       'Editor',
        contentText: `キイロがソラの原稿にREVISION_REQUIREDを出した（最大修正回数${maxRevisions}回超過）。テーマ「${project.theme ?? ''}」。人間によるレビューが必要。`,
        sourceType:  'cb_jobs',
        sourceId:    jobId,
      });
      applyJobEvent(db, 'editing_revision', { fromEmp: 'Writer', toEmp: 'Editor', jobId, projectId });
    });
    return { jobId, verdict: 'REVISION_REQUIRED', nextStatus: 'NEEDS_HUMAN_REVIEW', maxReached: true };
  }

  // 自動修正へ
  // P42-B + P43-A: REVISION（通常）
  setImmediate(() => {
    logEvent(db, {
      eventType:   'BUSINESS_HANDOFF',
      fromEmp:     'Writer',
      toEmp:       'Editor',
      contentText: `キイロがソラの原稿にREVISION_REQUIREDを出した（${project.revision_count + 1}回目）。テーマ「${project.theme ?? ''}」。ソラへ差し戻し。`,
      sourceType:  'cb_jobs',
      sourceId:    jobId,
    });
    applyJobEvent(db, 'editing_revision', { fromEmp: 'Writer', toEmp: 'Editor', jobId, projectId });
  });
  updateProjectStatus(db, projectId, 'AUTO_REVISION', {
    revisionCount: project.revision_count + 1,
  });
  return {
    jobId,
    verdict: 'REVISION_REQUIRED',
    nextStatus: 'AUTO_REVISION',
    revisionRequest: result.revision_request,
    revisionCount: project.revision_count + 1,
  };
}

/**
 * AUTO_REVISION フェーズ実行
 * Writer に修正指示を渡して再執筆
 */
export async function runAutoRevision(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  const latestDraft = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);

  const revisionRequest = latestDraft?.revision_request;
  return await runWriting(db, projectId, revisionRequest);
}

/**
 * 本人レビュー反映: 本人の修正指示を最新ドラフトへ反映する
 *
 * - MINOR（軽微）: キイロが直接修正 → 新version保存 → APPROVAL_WAIT
 * - MAJOR（大きな修正）: ソラへ差し戻し → 改稿 → キイロ再チェック → APPROVAL_WAIT
 *
 * @param {object} db
 * @param {number} projectId
 * @param {string} ownerInstruction - 本人の修正指示テキスト
 * @returns {{ type, reviewBy, newVersion, changesSummary }}
 */
export async function runOwnerReview(db, projectId, ownerInstruction, { reviewMode = 'revise' } = {}) {
  if (!ownerInstruction?.trim()) throw new Error('修正指示が空です');

  // エラーをクリア（新規試行）
  db.prepare("UPDATE cb_projects SET owner_review_error=NULL, updated_at=datetime('now','localtime') WHERE id=?").run(projectId);

  const latestDraft = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  if (!latestDraft) throw new Error('ドラフトが見つかりません');

  const draftData = {
    title_candidates: latestDraft.title_candidates ? JSON.parse(latestDraft.title_candidates) : [],
    lead:      latestDraft.lead,
    free_part: latestDraft.free_part,
    paid_part: latestDraft.paid_part,
    summary:   latestDraft.summary,
  };

  // ── FACT_CHECK モード ────────────────────────────────────────────────────
  if (reviewMode === 'fact_check') {
    // AIの現在の理解を箇条書きで提示。新ドラフトは作らない。
    const factList = await runFactCheckPresentation({ instruction: ownerInstruction, draft: draftData });
    db.prepare(`
      INSERT INTO cb_fact_check_results (project_id, draft_id, instruction, fact_list)
      VALUES (?, ?, ?, ?)
    `).run(projectId, latestDraft.id, ownerInstruction, factList);
    // ステータスはAPPROVAL_WAITのまま
    updateProjectStatus(db, projectId, 'APPROVAL_WAIT');
    return { type: 'FACT_CHECK', reviewBy: 'Writer', factList };
  }

  // ── 通常修正モード（MINOR / MAJOR）──────────────────────────────────────

  // 1. 修正規模を判定（キイロ）
  const { type, reason } = await runOwnerReviewJudge({
    instruction: ownerInstruction,
    draft: draftData,
  });

  updateProjectStatus(db, projectId, 'WRITING');

  let revised;
  let reviewBy;

  const knowledge = loadApprovedKnowledge(db);
  if (type === 'MINOR') {
    revised = await runEditorMinorRevision({ instruction: ownerInstruction, draft: draftData, approvedKnowledge: knowledge });
    reviewBy = 'Editor';
  } else {
    revised = await runWriterMajorRevision({ instruction: ownerInstruction, draft: draftData, approvedKnowledge: knowledge });
    reviewBy = 'Writer';
  }

  // 2. 新バージョンで保存
  const maxV = db.prepare('SELECT MAX(version) as v FROM cb_article_drafts WHERE project_id = ?').get(projectId)?.v ?? 0;
  const newVersion = maxV + 1;

  db.prepare(`
    INSERT INTO cb_article_drafts
      (project_id, version, title_candidates, lead, free_part, paid_part, summary,
       owner_review_instruction, review_type, review_by, changes_summary, editor_verdict)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, newVersion,
    JSON.stringify(revised.title_candidates ?? draftData.title_candidates),
    revised.lead   ?? draftData.lead,
    revised.free_part ?? draftData.free_part,
    revised.paid_part ?? draftData.paid_part,
    revised.summary   ?? draftData.summary,
    ownerInstruction, type, reviewBy,
    revised.changes_summary ?? '（変更サマリーなし）',
    type === 'MINOR' ? 'READY' : null
  );

  if (type === 'MINOR') {
    updateProjectStatus(db, projectId, 'APPROVAL_WAIT');
  } else {
    updateProjectStatus(db, projectId, 'EDITING');
    try {
      const editResult = await runEditing(db, projectId);
      if (editResult.verdict !== 'READY') {
        updateProjectStatus(db, projectId, 'APPROVAL_WAIT');
      }
    } catch (_) {
      updateProjectStatus(db, projectId, 'APPROVAL_WAIT');
    }
  }

  return { type, reason, reviewBy, newVersion, changesSummary: revised.changes_summary };
}

/**
 * アサヒへの直接企画依頼（市場調査なし）
 * @returns {{ planId, plan }}
 */
export async function runDirectPlan(db, { theme, purpose, usableFacts, avoid, notes }) {
  const plan = await runDirectPlanProposal({ theme, purpose, usableFacts, avoid, notes });
  const result = db.prepare(`
    INSERT INTO cb_direct_plans (theme, purpose, usable_facts, avoid, notes, plan_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(theme, purpose ?? null, usableFacts ?? null, avoid ?? null, notes ?? null, JSON.stringify(plan));
  return { planId: result.lastInsertRowid, plan };
}

/**
 * 企画採用後の事実確認（ドラフトなし・本文生成なし）
 *
 * 確定情報源（kotoriプロフィール / approvedKnowledge / 公開済み記事 / 本人提供事実）のみ参照。
 * AIによる推測・補完は行わない。
 * 結果を cb_fact_check_results に保存して返す。
 */
export async function runIdeaFactCheckFromIdea(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  if (project.selected_idea_index == null) throw new Error('先に案を採用してください');

  const idea = db.prepare(
    'SELECT * FROM cb_ideas WHERE project_id = ? AND idea_index = ?'
  ).get(projectId, project.selected_idea_index);

  // 確定情報源1: approved の事実ナレッジ
  const approvedKnowledgeFacts = loadApprovedKnowledge(db).filter(k => k.category === 'FACT');

  // 確定情報源2: 公開・承認済み記事のタイトル一覧
  const publishedTitles = db.prepare(`
    SELECT p.theme, d.title_candidates
    FROM cb_projects p
    LEFT JOIN cb_article_drafts d ON d.project_id = p.id AND d.version = (
      SELECT MAX(version) FROM cb_article_drafts WHERE project_id = p.id
    )
    WHERE p.status IN ('APPROVED','PUBLISHED','MEASURING') AND p.deleted_at IS NULL AND p.id != ?
    ORDER BY p.updated_at DESC LIMIT 20
  `).all(projectId).map(r => {
    try { return JSON.parse(r.title_candidates)?.[0] ?? r.theme; } catch { return r.theme; }
  }).filter(Boolean);

  // 確定情報源3: 本人が今回提供した「使ってよい事実・経験」
  // cb_direct_plans があればそこから取得（なければ null）
  const directPlan = db.prepare(
    'SELECT usable_facts FROM cb_direct_plans WHERE project_id = ? ORDER BY id DESC LIMIT 1'
  ).get(projectId);
  const usableFacts = directPlan?.usable_facts ?? null;

  // 確定情報源4: kotori公開プロフィール
  let profile = null;
  try { profile = readFileSync(resolve(__dirname, '../config/kotori_public_profile.md'), 'utf8').slice(0, 2000); } catch (_) {}

  const factList = await runIdeaFactCheck({
    idea: idea ?? {},
    theme: project.theme,
    usableFacts,
    approvedKnowledgeFacts,
    publishedTitles,
    profile,
  });

  const result = db.prepare(`
    INSERT INTO cb_fact_check_results (project_id, draft_id, instruction, fact_list)
    VALUES (?, NULL, '企画採用後の事前確認', ?)
  `).run(projectId, factList);

  return { factCheckId: result.lastInsertRowid, factList };
}

/**
 * 企画採用後の構成作成（本文なし・見出し骨格のみ）
 * - 本文は生成しない
 * - 構成テキストを返す（DBには保存しない、UI表示のみ）
 */
export async function runIdeaOutlineOnly(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  if (project.selected_idea_index == null) throw new Error('先に案を採用してください');

  const idea = db.prepare(
    'SELECT * FROM cb_ideas WHERE project_id = ? AND idea_index = ?'
  ).get(projectId, project.selected_idea_index);

  const outline = await runIdeaOutlinePlanner({
    idea: idea ?? {},
    theme: project.theme,
    genre: project.genre,
    targetReader: project.target_reader,
  });

  return { outline };
}

/**
 * 既存ドラフトを元に修正版を作成（企画案なしプロジェクト用）
 * - runWriting とは異なり「採用案」ではなく「latestDraft 本文」を使う
 * - 修正後は新 version として保存、editor_verdict を NULL に初期化
 */
export async function runWritingFromDraft(db, projectId, revisionRequest) {
  updateProjectStatus(db, projectId, 'WRITING');

  const latestDraft = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  if (!latestDraft) throw new Error('修正元のドラフトが存在しません');

  const draftData = {
    title_candidates: latestDraft.title_candidates ? JSON.parse(latestDraft.title_candidates) : [],
    lead: latestDraft.lead,
    free_part: latestDraft.free_part,
    paid_part: latestDraft.paid_part,
    summary: latestDraft.summary,
  };

  const knowledge = loadApprovedKnowledge(db);
  const { jobId, result } = await runJobWithRetry(db, projectId, 'WRITING', async () => {
    return await runWriterRevision({ existingDraft: draftData, revisionRequest, approvedKnowledge: knowledge });
  });

  // 新バージョンとして保存（元ドラフトは残す）
  const lastDraft = db.prepare(
    'SELECT MAX(version) as max_v FROM cb_article_drafts WHERE project_id = ?'
  ).get(projectId);
  const newVersion = (lastDraft?.max_v ?? 0) + 1;

  db.prepare(`
    INSERT INTO cb_article_drafts
      (project_id, version, title_candidates, lead, free_part, paid_part, summary,
       editor_verdict, revision_request)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    projectId, newVersion,
    JSON.stringify(result.title_candidates ?? []),
    result.lead || null, result.free_part || null,
    result.paid_part || null, result.summary || null,
    revisionRequest || null
  );

  updateProjectStatus(db, projectId, 'EDITING');
  return { jobId, newVersion };
}

/**
 * フルオート実行（既存ドラフトベース修正）: WRITING → EDITING → AUTO_REVISION → APPROVAL_WAIT
 * 企画案なし手動作成プロジェクトの修正依頼時に使用
 */
export async function runFullAutoFromDraft(db, projectId) {
  const latestDraft = db.prepare(
    'SELECT revision_request FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  if (!latestDraft) throw new Error('修正元のドラフトが存在しません');

  const config = JSON.parse(readFileSync(resolve(__dirname, '../config/content_business.json'), 'utf8'));
  const maxRevisions = config.generation?.max_auto_revisions ?? 2;

  try {
    // WRITING（既存ドラフト修正）
    await runWritingFromDraft(db, projectId, latestDraft.revision_request);

    // EDITING → 必要なら AUTO_REVISION を繰り返す
    let attempts = 0;
    let editResult;
    while (attempts <= maxRevisions) {
      editResult = await runEditing(db, projectId);

      if (editResult.verdict === 'READY') break;
      if (editResult.verdict === 'BLOCKED') break;
      if (editResult.nextStatus === 'NEEDS_HUMAN_REVIEW') break;
      if (editResult.maxReached) break;

      if (editResult.nextStatus === 'AUTO_REVISION') {
        // AUTO_REVISION も既存ドラフトベースで修正
        const revised = db.prepare(
          'SELECT revision_request FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
        ).get(projectId);
        await runWritingFromDraft(db, projectId, revised?.revision_request ?? null);
        attempts++;
      } else {
        break;
      }
    }

    return { ok: true, editResult, status: editResult.nextStatus };
  } catch (err) {
    updateProjectStatus(db, projectId, 'ERROR');
    throw err;
  }
}

/**
 * フルオート実行: RESEARCH → ANALYSIS → IDEA_REVIEW → OWNER_IDEA_APPROVAL（停止）
 * 社長が「AI編集部に任せる」を押したときに呼ぶ
 * research_mode により NONE / LIGHT / FULL の3種類に分岐する
 */
export async function runFullAutoUntilIdeaApproval(db, projectId) {
  const project = db.prepare('SELECT research_mode FROM cb_projects WHERE id = ?').get(projectId);
  const researchMode = project?.research_mode ?? 'LIGHT';

  try {
    // ── NONE モード: 外部調査なし → 直接企画 ──────────────────────────────
    if (researchMode === 'NONE') {
      const ideaResult = await runNoneIdeaReview(db, projectId);
      return { ok: true, mode: 'NONE', ideas: ideaResult.ideas, status: 'OWNER_IDEA_APPROVAL' };
    }

    // ── LIGHT / FULL モード: 調査あり ────────────────────────────────────
    const researchResult = await runResearch(db, projectId);

    // LIGHT で0件: ERROR にせず RESEARCH のまま UI に委ねる
    if (researchResult.noResults) {
      return {
        ok: false,
        noResults: true,
        mode: 'LIGHT',
        status: 'RESEARCH',
        message: '市場調査データを取得できませんでした',
      };
    }

    // ANALYSIS
    const analysisResult = await runAnalysis(db, projectId);

    // IDEA_REVIEW → OWNER_IDEA_APPROVAL で停止
    const ideaResult = await runIdeaReview(db, projectId, analysisResult.analysis);

    return {
      ok: true,
      mode: researchMode,
      research: researchResult,
      analysis: analysisResult,
      ideas: ideaResult.ideas,
      status: 'OWNER_IDEA_APPROVAL',
    };
  } catch (err) {
    updateProjectStatus(db, projectId, 'ERROR');
    throw err;
  }
}

/**
 * フルオート実行: WRITING → EDITING → AUTO_REVISION（最大2回）→ APPROVAL_WAIT（停止）
 * 社長が案を選択したときに呼ぶ
 */
export async function runFullAutoUntilApproval(db, projectId) {
  // 企画案なしのプロジェクト（手動作成）はこのフローを実行できない
  const hasIdea = db.prepare(
    'SELECT 1 FROM cb_ideas WHERE project_id = ? LIMIT 1'
  ).get(projectId);
  if (!hasIdea) {
    throw new Error(
      '企画案が存在しません。このプロジェクトは手動作成のため、調査→分析→企画フローを先に完了してください。'
    );
  }

  try {
    const config = JSON.parse(readFileSync(resolve(__dirname, '../config/content_business.json'), 'utf8'));
    const maxRevisions = config.generation?.max_auto_revisions ?? 2;

    // 1. WRITING
    await runWriting(db, projectId, null);

    // 2. EDITING → 必要なら AUTO_REVISION を繰り返す
    let attempts = 0;
    let editResult;
    while (attempts <= maxRevisions) {
      editResult = await runEditing(db, projectId);

      if (editResult.verdict === 'READY') break;
      if (editResult.verdict === 'BLOCKED') break;
      if (editResult.nextStatus === 'NEEDS_HUMAN_REVIEW') break;
      if (editResult.maxReached) break;

      // AUTO_REVISION
      if (editResult.nextStatus === 'AUTO_REVISION') {
        const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
        await runAutoRevision(db, projectId);
        attempts++;
      } else {
        break;
      }
    }

    return { ok: true, editResult, status: editResult.nextStatus };
  } catch (err) {
    updateProjectStatus(db, projectId, 'ERROR');
    throw err;
  }
}

/**
 * キイロが1回だけ編集チェックする（自動修正ループなし）
 * 判定結果を draft に保存し、ステータスは EDITING のまま止まる。
 * 社長が次のアクション（ソラに修正依頼 / 公開待ちへ進む）を明示的に選ぶ。
 */
export async function runEditingOnce(db, projectId) {
  updateProjectStatus(db, projectId, 'EDITING');
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);

  const latestDraft = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  if (!latestDraft) throw new Error('原稿ドラフトが見つかりません');

  const selectedIdea = db.prepare(
    'SELECT * FROM cb_ideas WHERE project_id = ? AND idea_index = ?'
  ).get(projectId, project.selected_idea_index ?? 1);
  const ideaData = selectedIdea?.raw_json ? JSON.parse(selectedIdea.raw_json) : selectedIdea;

  const draftData = {
    title_candidates: latestDraft.title_candidates ? JSON.parse(latestDraft.title_candidates) : [],
    lead: latestDraft.lead,
    free_part: latestDraft.free_part,
    paid_part: latestDraft.paid_part,
    summary: latestDraft.summary,
  };

  const knowledge = loadApprovedKnowledge(db);
  const { jobId, result } = await runJobWithRetry(db, projectId, 'EDITING', async () => {
    return await runEditor({ draft: draftData, selectedIdea: ideaData, approvedKnowledge: knowledge });
  });

  // 判定結果をドラフトに保存（有料適性判定も含む）
  db.prepare(`
    UPDATE cb_article_drafts
    SET editor_verdict = ?, editor_notes = ?, revision_request = ?,
        price_type = ?, paid_appropriateness = ?, paid_appropriateness_reason = ?
    WHERE id = ?
  `).run(
    result.verdict,
    result.notes,
    result.revision_request || null,
    result.price_type || null,
    result.paid_appropriateness || null,
    result.paid_appropriateness_reason || null,
    latestDraft.id
  );

  // READY でも REVISION_REQUIRED でも EDITING のまま止まる
  // 社長が次のアクションを明示的に選ぶまで自動で進まない
  updateProjectStatus(db, projectId, 'EDITING');

  return {
    jobId,
    verdict: result.verdict,
    revisionRequest: result.revision_request,
    notes: result.notes,
  };
}

/**
 * APPROVAL_WAIT へ手動昇格（社長が「公開待ちへ進む」を選んだとき）
 * editor_verdict チェックなし — 社長の明示的な判断を優先する。
 */
export function advanceToApproval(db, projectId) {
  const project = db.prepare('SELECT status FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  if (project.status !== 'EDITING') {
    throw new Error(`公開待ちへの昇格は EDITING ステータスでのみ可能です（現在: ${project.status}）`);
  }
  updateProjectStatus(db, projectId, 'APPROVAL_WAIT');
}

/**
 * ソラによる下書き修正のみ実行（キイロ編集は自動起動しない）
 * 「ソラに修正依頼」ボタンから呼ぶ。修正後は EDITING のまま止まる。
 */
export async function runWriterRevisionOnly(db, projectId, instruction) {
  if (!instruction?.trim()) throw new Error('修正指示が空です');

  const latestDraft = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  if (!latestDraft) throw new Error('修正対象のドラフトが見つかりません');

  updateProjectStatus(db, projectId, 'WRITING');

  const draftData = {
    title_candidates: latestDraft.title_candidates ? JSON.parse(latestDraft.title_candidates) : [],
    lead: latestDraft.lead,
    free_part: latestDraft.free_part,
    paid_part: latestDraft.paid_part,
    summary: latestDraft.summary,
  };

  const knowledge = loadApprovedKnowledge(db);
  const { jobId, result } = await runJobWithRetry(db, projectId, 'WRITING', async () => {
    return await runWriterRevision({ existingDraft: draftData, revisionRequest: instruction, approvedKnowledge: knowledge });
  });

  // 新バージョンとして保存
  const lastDraft = db.prepare(
    'SELECT MAX(version) as max_v FROM cb_article_drafts WHERE project_id = ?'
  ).get(projectId);
  const newVersion = (lastDraft?.max_v ?? 0) + 1;

  db.prepare(`
    INSERT INTO cb_article_drafts
      (project_id, version, title_candidates, lead, free_part, paid_part, summary, revision_request)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, newVersion,
    JSON.stringify(result.title_candidates ?? []),
    result.lead || null, result.free_part || null,
    result.paid_part || null, result.summary || null,
    instruction
  );

  // 編集待ち状態に戻す（キイロは自動起動しない）
  updateProjectStatus(db, projectId, 'EDITING');
  return { jobId, version: newVersion };
}

/**
 * プロジェクト取得（ダッシュボード用）
 */
export function getProject(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) return null;

  const ideas = db.prepare('SELECT * FROM cb_ideas WHERE project_id = ? ORDER BY idea_index').all(projectId);
  const latestDraft = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  const jobs = db.prepare(
    'SELECT * FROM cb_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(projectId);
  const salesRecords = db.prepare(
    'SELECT * FROM cb_sales_records WHERE project_id = ? ORDER BY record_date DESC'
  ).all(projectId);
  const researchCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM cb_research_items WHERE project_id = ?'
  ).get(projectId)?.cnt ?? 0;

  const researchItems = db.prepare(
    'SELECT id, url, title, author, price, published_at, source, fetch_ok, fetch_error, fetched_at, created_at FROM cb_research_items WHERE project_id = ? ORDER BY id'
  ).all(projectId);

  return { project, ideas, latestDraft, jobs, salesRecords, researchCount, research_items: researchItems };
}

/**
 * プロジェクト一覧取得（ダッシュボード用）
 */
export function listProjects(db) {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM cb_research_items WHERE project_id = p.id) AS research_count,
      (SELECT MAX(version) FROM cb_article_drafts WHERE project_id = p.id) AS draft_version,
      s.name AS series_name
    FROM cb_projects p
    LEFT JOIN cb_series s ON s.id = p.series_id
    WHERE p.deleted_at IS NULL
    ORDER BY p.updated_at DESC
    LIMIT 100
  `).all();
}

/**
 * シリーズ一覧取得（各シリーズ内のプロジェクトも含む）
 */
export function listSeries(db) {
  const series = db.prepare(`SELECT * FROM cb_series ORDER BY id`).all();
  return series.map(s => {
    const projects = db.prepare(`
      SELECT p.id, p.theme, p.status, p.series_order, p.deleted_at, p.is_dropped,
        (SELECT MAX(version) FROM cb_article_drafts WHERE project_id = p.id) AS draft_version
      FROM cb_projects p
      WHERE p.series_id = ? AND p.deleted_at IS NULL
      ORDER BY p.series_order
    `).all(s.id);
    return { ...s, projects };
  });
}

// ── シリーズ進行管理 ───────────────────────────────────────────────────────────

const SERIES_IN_PROGRESS_STATUSES = new Set([
  'IDEA_REVIEW', 'OWNER_IDEA_APPROVAL', 'WRITING', 'EDITING',
  'AUTO_REVISION', 'APPROVAL_WAIT', 'NEEDS_HUMAN_REVIEW',
]);
const SERIES_DONE_STATUSES = new Set(['APPROVED', 'PUBLISHED', 'MEASURING']);
// PLANNED = シリーズ登録済み・AI処理未開始（孤児防止のための専用ステータス）
const SERIES_NOT_STARTED_STATUSES = new Set(['PLANNED']);

const NEXT_WORKER_LABELS = {
  PLANNED:              '未着手',
  RESEARCH:             'アサヒ（企画準備中）',
  IDEA_REVIEW:          'アサヒ（企画作成中）',
  OWNER_IDEA_APPROVAL:  '本人（企画選択待ち）',
  WRITING:              'ソラ（執筆中）',
  EDITING:              'キイロ（編集中）',
  AUTO_REVISION:        'ソラ/キイロ（修正中）',
  APPROVAL_WAIT:        '本人（公開確認待ち）',
  APPROVED:             '本人（note投稿待ち）',
  PUBLISHED:            'アオ（計測中）',
  MEASURING:            'アオ（計測中）',
  ERROR:                '要確認',
  CANCELLED:            '—',
};

/**
 * シリーズの進行状態を取得する（UI表示・進行可否判定用）
 *
 * @returns {{
 *   seriesId: number,
 *   inProgressProject: object|null,
 *   nextProject: object|null,
 *   canStartNext: boolean,
 *   readyMessage: string|null,
 *   projects: object[]
 * }}
 */
export function getSeriesProgress(db, seriesId) {
  const projects = db.prepare(`
    SELECT p.id, p.theme, p.status, p.series_order, p.research_mode, p.is_dropped,
      (SELECT MAX(version) FROM cb_article_drafts WHERE project_id = p.id) AS draft_version
    FROM cb_projects p
    WHERE p.series_id = ? AND p.deleted_at IS NULL
    ORDER BY p.series_order
  `).all(seriesId);

  // DROPPED 記事は「進行中」にも「未着手」にも含めない
  const inProgressProject = projects.find(p => !p.is_dropped && SERIES_IN_PROGRESS_STATUSES.has(p.status)) ?? null;
  const notStarted = projects.filter(p => !p.is_dropped && SERIES_NOT_STARTED_STATUSES.has(p.status));
  const nextProject = notStarted.length > 0 ? notStarted[0] : null;

  const lastDone = [...projects].reverse().find(p => SERIES_DONE_STATUSES.has(p.status));
  const canStartNext = !inProgressProject && nextProject !== null;

  let readyMessage = null;
  if (canStartNext && lastDone) {
    readyMessage = `第${lastDone.series_order}回が${lastDone.status === 'APPROVED' ? '公開承認' : '公開'}済みです。次の記事を進められます。`;
  }

  return {
    seriesId,
    inProgressProject,
    nextProject,
    canStartNext,
    readyMessage,
    projects: projects.map(p => ({
      ...p,
      next_worker: NEXT_WORKER_LABELS[p.status] ?? p.status,
      is_done: SERIES_DONE_STATUSES.has(p.status),
      is_in_progress: SERIES_IN_PROGRESS_STATUSES.has(p.status),
      is_not_started: SERIES_NOT_STARTED_STATUSES.has(p.status),
    })),
  };
}

/**
 * シリーズの次の記事を開始する（NONE フロー: アサヒ企画 → OWNER_IDEA_APPROVAL で停止）
 *
 * 前提条件:
 * - 進行中の記事がないこと
 * - 未着手の記事が存在すること
 * - series_id=1 は research_mode=NONE で実行
 *
 * @returns {{ projectId, status, ideas }}
 */
export async function startNextSeriesArticle(db, seriesId) {
  const progress = getSeriesProgress(db, seriesId);

  if (progress.inProgressProject) {
    throw new Error(
      `第${progress.inProgressProject.series_order}回「${progress.inProgressProject.theme?.slice(0, 20)}」が進行中です。完了してから次の記事を開始してください。`
    );
  }
  if (!progress.nextProject) {
    throw new Error('未着手の記事がありません。シリーズはすべて完了しています。');
  }

  const projectId = progress.nextProject.id;

  // research_mode=NONE を保証、PLANNED → RESEARCH に遷移（runNoneIdeaReview が IDEA_REVIEW に進める）
  db.prepare(
    "UPDATE cb_projects SET research_mode = 'NONE', status = 'RESEARCH', updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(projectId);

  // NONE フロー実行（RESEARCH/ANALYSISをスキップ → アサヒ企画 → OWNER_IDEA_APPROVAL で停止）
  const result = await runNoneIdeaReview(db, projectId);
  return { projectId, status: 'OWNER_IDEA_APPROVAL', ideas: result.ideas };
}

/**
 * ERRORプロジェクトを論理削除する
 * - status が ERROR のプロジェクトのみ対象
 * - deleted_at に現在時刻を設定（物理削除しない）
 */
export function softDeleteProject(db, projectId) {
  const project = db.prepare(
    'SELECT id, status, deleted_at FROM cb_projects WHERE id = ?'
  ).get(projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  if (project.status !== 'ERROR') throw new Error('ERRORステータスのプロジェクトのみ削除できます');
  if (project.deleted_at) throw new Error('すでに削除済みです');

  db.prepare(
    "UPDATE cb_projects SET deleted_at = datetime('now','localtime') WHERE id = ?"
  ).run(projectId);
  return { ok: true, deleted: true, project_id: projectId };
}

/**
 * ERRORかつ未削除のプロジェクトをまとめて論理削除する
 */
export function softDeleteAllErrorProjects(db) {
  const result = db.prepare(
    "UPDATE cb_projects SET deleted_at = datetime('now','localtime') WHERE status = 'ERROR' AND deleted_at IS NULL"
  ).run();
  return { ok: true, deleted: true, count: result.changes };
}

// プロジェクトステータスから各社員の状態を導出するマップ
const PROJECT_STATUS_TO_EMPLOYEE = {
  RESEARCH:             { id: 'Scout',   status: 'WORKING',  task: '公開記事を取得しています' },
  ANALYSIS:             { id: 'Analyst', status: 'WORKING',  task: '市場構造を分析しています' },
  IDEA_REVIEW:          { id: 'Planner', status: 'WORKING',  task: '商品候補3案を作成しています' },
  OWNER_IDEA_APPROVAL:  { id: 'Planner', status: 'WAITING',  task: '社長の案選択を待っています' },
  WRITING:              { id: 'Writer',  status: 'WORKING',  task: '記事の本文を執筆しています' },
  EDITING:              { id: 'Editor',  status: 'WORKING',  task: '原稿をチェックしています' },
  AUTO_REVISION:        { id: 'Writer',  status: 'WORKING',  task: '指摘箇所を修正しています' },
  APPROVAL_WAIT:        { id: 'Editor',  status: 'WAITING',  task: '社長の公開承認を待っています' },
  NEEDS_HUMAN_REVIEW:   { id: 'Editor',  status: 'ERROR',    task: '手動確認が必要です' },
  MEASURING:            { id: 'Growth',  status: 'WORKING',  task: '売上データを分析しています' },
};

const EMPLOYEE_DEFS = [
  { id: 'Scout',   display_name: 'ヒカゲ', role: '市場調査',   image: '/content-business-assets/employees/hikage.png',  default_task: '次の調査依頼を待っています' },
  { id: 'Analyst', display_name: 'ヒノデ', role: '市場分析',   image: '/content-business-assets/employees/hinode.png',  default_task: '分析依頼を待っています' },
  { id: 'Planner', display_name: 'アサヒ', role: '商品企画',   image: '/content-business-assets/employees/asahi.png',   default_task: '企画依頼を待っています' },
  { id: 'Writer',  display_name: 'ソラ',   role: '執筆',       image: '/content-business-assets/employees/sora.png',    default_task: '執筆依頼を待っています' },
  { id: 'Editor',  display_name: 'キイロ', role: '編集長',     image: '/content-business-assets/employees/kiiro.png',   default_task: '原稿を待っています' },
  { id: 'Growth',  display_name: 'アオ',   role: '販売分析',   image: '/content-business-assets/employees/ao.png',      default_task: '売上データを待っています' },
];

/**
 * AI社員ステータス一覧を返す
 * 進行中プロジェクトの状態から各社員の現在のステータスを導出する
 */
export function getCbEmployeeStatuses(db) {
  // 直近72時間以内に更新されたアクティブプロジェクトを取得
  const activeProjects = db.prepare(`
    SELECT id, theme, genre, status, updated_at
    FROM cb_projects
    WHERE status NOT IN ('PUBLISHED','MEASURING','CANCELLED','ERROR')
      AND deleted_at IS NULL
      AND updated_at >= datetime('now', '-72 hours', 'localtime')
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();

  // 完了済みジョブから「最後に完了した仕事」を社員ごとに取得
  const lastDoneJobs = db.prepare(`
    SELECT j.job_type, j.finished_at, j.project_id, p.theme, p.genre
    FROM cb_jobs j
    LEFT JOIN cb_projects p ON p.id = j.project_id
    WHERE j.status = 'DONE'
    ORDER BY j.finished_at DESC
    LIMIT 50
  `).all();

  // 社員IDとジョブタイプのマッピング
  const jobToEmployee = {
    RESEARCH:    'Scout',
    ANALYSIS:    'Analyst',
    IDEA_REVIEW: 'Planner',
    WRITING:     'Writer',
    EDITING:     'Editor',
  };

  const lastDoneByEmployee = {};
  for (const job of lastDoneJobs) {
    const empId = jobToEmployee[job.job_type];
    if (empId && !lastDoneByEmployee[empId]) {
      lastDoneByEmployee[empId] = {
        task: job.job_type,
        project_label: job.theme || job.genre || `プロジェクト#${job.project_id}`,
        finished_at: job.finished_at,
      };
    }
  }

  // アクティブプロジェクトから各社員の現在状態を決定
  const workingEmployees = new Map(); // id → { status, task, project_label, updated_at }
  for (const proj of activeProjects) {
    const mapping = PROJECT_STATUS_TO_EMPLOYEE[proj.status];
    if (!mapping) continue;
    if (workingEmployees.has(mapping.id)) continue; // 最新プロジェクトを優先

    // RESEARCH 状態でジョブが1件もない場合は孤児プロジェクト → WORKING にしない
    if (proj.status === 'RESEARCH') {
      const jobCount = db.prepare(
        'SELECT COUNT(*) AS cnt FROM cb_jobs WHERE project_id = ?'
      ).get(proj.id)?.cnt ?? 0;
      if (jobCount === 0) continue;
    }

    workingEmployees.set(mapping.id, {
      status: mapping.status,
      task: mapping.task,
      project_label: proj.theme || proj.genre || `プロジェクト#${proj.id}`,
      updated_at: proj.updated_at,
    });
  }

  const personalities = getPersonalities();

  // 全社員の状態を組み立て
  return EMPLOYEE_DEFS.map(emp => {
    const working = workingEmployees.get(emp.id);
    const lastDone = lastDoneByEmployee[emp.id];
    const empStatus = working ? working.status : 'IDLE';
    const projectLabel = working?.project_label ?? null;
    const p = personalities[emp.id] ?? {};
    return {
      id:              emp.id,
      display_name:    emp.display_name,
      role:            emp.role,
      image:           emp.image,
      status:          empStatus,
      current_task:    working ? `${working.task}（${working.project_label}）` : emp.default_task,
      current_message: pickEmployeeMessage(emp.id, empStatus, projectLabel),
      first_message:   p.first_message ?? null,
      last_done:       lastDone
        ? `${lastDone.project_label}の${lastDone.task}`
        : null,
      last_done_at:    lastDone?.finished_at ?? null,
      updated_at:      working?.updated_at ?? lastDone?.finished_at ?? null,
    };
  });
}

/**
 * 週次サマリー取得
 */
export function getWeeklySummary(db) {
  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return {
    researched: db.prepare(
      "SELECT COUNT(*) as cnt FROM cb_projects WHERE created_at >= ?"
    ).get(weekAgo)?.cnt ?? 0,
    ideas_proposed: db.prepare(
      "SELECT COUNT(*) as cnt FROM cb_ideas WHERE created_at >= ?"
    ).get(weekAgo)?.cnt ?? 0,
    writing: db.prepare(
      "SELECT COUNT(*) as cnt FROM cb_projects WHERE status IN ('WRITING','EDITING','AUTO_REVISION')"
    ).get()?.cnt ?? 0,
    approval_wait: db.prepare(
      "SELECT COUNT(*) as cnt FROM cb_projects WHERE status = 'APPROVAL_WAIT'"
    ).get()?.cnt ?? 0,
    published: db.prepare(
      "SELECT COUNT(*) as cnt FROM cb_projects WHERE status IN ('PUBLISHED','MEASURING')"
    ).get()?.cnt ?? 0,
    monthly_revenue: db.prepare(
      "SELECT COALESCE(SUM(revenue),0) as total FROM cb_sales_records WHERE record_date >= date('now','-30 days')"
    ).get()?.total ?? 0,
  };
}

/**
 * 社長が案を選択
 */
export function selectIdea(db, projectId, ideaIndex) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  if (project.status !== 'OWNER_IDEA_APPROVAL') {
    throw new Error(`案選択は OWNER_IDEA_APPROVAL ステータスでのみ可能です（現在: ${project.status}）`);
  }
  db.prepare(
    "UPDATE cb_projects SET selected_idea_index = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(ideaIndex, projectId);
}

/**
 * 社長が公開承認
 */
export function approvePublication(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  if (project.status !== 'APPROVAL_WAIT') {
    throw new Error(`公開承認は APPROVAL_WAIT ステータスでのみ可能です（現在: ${project.status}）`);
  }

  // 編集チェック未実施・非READY の原稿は公開承認できない
  const latestDraft = db.prepare(
    'SELECT id, version, editor_verdict FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  if (!latestDraft) {
    throw new Error('原稿が見つかりません。先に執筆フローを完了してください。');
  }
  if (latestDraft.editor_verdict === null) {
    throw new Error('編集チェック未実施です。キイロの編集チェック（EDITING）を先に実行してください。');
  }
  if (latestDraft.editor_verdict !== 'READY') {
    throw new Error(`編集チェック結果が READY ではありません（現在: ${latestDraft.editor_verdict}）。修正フローを完了してください。`);
  }

  // APPROVED状態に変更（外部公開は行わない・社長が手動でnoteへ投稿）
  db.prepare(
    "UPDATE cb_projects SET status = 'APPROVED', updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(projectId);

  // 学び抽出を非同期でトリガー（承認レスポンスをブロックしない）
  setImmediate(() => {
    extractLearnings(db, projectId, latestDraft.version).catch(e =>
      console.error(`[学び抽出] プロジェクト#${projectId} エラー:`, e.message)
    );
  });
}

/**
 * 公開承認後に学び候補を抽出して cb_editorial_learnings に pending で保存する。
 * 同一 version に対して複数回実行しない。
 * 本人による修正（直接編集 or 本人レビュー）が1件もない場合はスキップ。
 *
 * @param {object} db
 * @param {number} projectId
 * @param {number} approvedVersion - 公開承認時の最新 draft version
 */
export async function extractLearnings(db, projectId, approvedVersion) {
  // 二重実行防止: 同一 version で既に抽出済みならスキップ
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) return;
  if (project.learnings_extracted_version === approvedVersion) {
    console.log(`[学び抽出] P#${projectId} v${approvedVersion} は抽出済みのためスキップ`);
    return;
  }

  // 全ドラフトを取得
  const allDrafts = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version ASC'
  ).all(projectId);

  // 直接編集（owner_edited=1 かつ diff_json あり）
  const directEdits = allDrafts.filter(d => d.owner_edited === 1 && d.diff_json);

  // 本人レビュー反映（owner_review_instruction あり）
  // 最終的に公開OKされたので「承認済み」扱いでよい
  const ownerReviews = allDrafts.filter(d => d.owner_review_instruction);

  // 修正が何もなければスキップ
  if (directEdits.length === 0 && ownerReviews.length === 0) {
    console.log(`[学び抽出] P#${projectId} 本人修正なし → スキップ`);
    db.prepare(
      "UPDATE cb_projects SET learnings_extracted_version = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(approvedVersion, projectId);
    return;
  }

  console.log(`[学び抽出] P#${projectId} 開始 (直接編集:${directEdits.length}件 レビュー指示:${ownerReviews.length}件)`);

  // AI で学び抽出
  const candidates = await runLearningsExtractor({
    directEdits:  directEdits.map(d => ({ version: d.version, diff_json: d.diff_json })),
    ownerReviews: ownerReviews.map(d => ({
      version: d.version,
      owner_review_instruction: d.owner_review_instruction,
      changes_summary: d.changes_summary,
    })),
    projectTheme: project.theme ?? project.genre,
  });

  console.log(`[学び抽出] P#${projectId} ${candidates.length}件の候補を抽出`);

  // pending で保存（AIは自動 approved にしない）
  const stmt = db.prepare(`
    INSERT INTO cb_editorial_learnings
      (category, rule_text, source_type, source_project_id, source_draft_version,
       trust_level, approval_status, is_active)
    VALUES (?, ?, ?, ?, ?, 'ai_suggested', 'pending', 1)
  `);

  let saved = 0;
  for (const c of candidates) {
    const validCategories = ['FACT', 'PRIVACY', 'STYLE', 'EDITORIAL_RULE', 'ARTICLE_SPECIFIC', 'REJECTED'];
    const validSources    = ['DIRECT_EDIT', 'OWNER_REVIEW'];
    if (!validCategories.includes(c.category)) continue;
    if (!c.rule_text?.trim()) continue;
    const sourceType = validSources.includes(c.source_type) ? c.source_type : 'DIRECT_EDIT';
    stmt.run(
      c.category,
      c.rule_text.trim(),
      sourceType,
      projectId,
      c.source_draft_version ?? null,
    );
    saved++;
  }

  // 抽出済みバージョンを記録
  db.prepare(
    "UPDATE cb_projects SET learnings_extracted_version = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(approvedVersion, projectId);

  console.log(`[学び抽出] P#${projectId} ${saved}件を pending で保存 (v${approvedVersion})`);
}

/**
 * 社長が修正依頼
 */
export function requestRevision(db, projectId, revisionNote) {
  db.prepare(
    "UPDATE cb_projects SET status = 'WRITING', revision_count = revision_count + 1, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(projectId);
  // 修正指示をドラフトに記録
  const latestDraft = db.prepare(
    'SELECT * FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
  ).get(projectId);
  if (latestDraft) {
    db.prepare('UPDATE cb_article_drafts SET revision_request = ? WHERE id = ?')
      .run(revisionNote, latestDraft.id);
  }
}

/**
 * 保留
 */
export function holdProject(db, projectId) {
  db.prepare(
    "UPDATE cb_projects SET status = 'APPROVAL_WAIT', updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(projectId);
}

/**
 * 公開済みとしてマーク（社長が手動でnoteに投稿後に押す）
 */
export function markPublished(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!['APPROVED'].includes(project?.status)) {
    throw new Error('APPROVED ステータスのプロジェクトのみ公開済みにできます');
  }
  db.prepare(
    "UPDATE cb_projects SET status = 'PUBLISHED', updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(projectId);
}

/**
 * 公開済みからMEASURING（アオの販売分析フェーズ）へ移行
 */
export function startMeasuring(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!['PUBLISHED'].includes(project?.status)) {
    throw new Error('PUBLISHED ステータスのプロジェクトのみ分析フェーズに移行できます');
  }
  db.prepare(
    "UPDATE cb_projects SET status = 'MEASURING', updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(projectId);
}

/**
 * プロジェクトをピン留め（固定記事）に設定 / 解除
 */
export function pinProject(db, projectId, pinned) {
  db.prepare(
    "UPDATE cb_projects SET is_pinned = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(pinned ? 1 : 0, projectId);
}

/**
 * 調査URLを手動追加
 */
export function addResearchUrl(db, projectId, urlData) {
  return db.prepare(`
    INSERT INTO cb_research_items
      (project_id, url, title, author, price, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    urlData.url || null, urlData.title || null, urlData.author || null,
    urlData.price || null, urlData.notes || null
  ).lastInsertRowid;
}

/**
 * 売上データを追加
 */
export function addSalesRecord(db, projectId, data) {
  return db.prepare(`
    INSERT INTO cb_sales_records
      (project_id, record_date, pv, purchase_count, revenue, price, sns_traffic, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, data.record_date, data.pv ?? null, data.purchase_count ?? null,
    data.revenue ?? null, data.price ?? null, data.sns_traffic ?? null, data.memo ?? null
  ).lastInsertRowid;
}

/**
 * 日次メトリクスを保存（同日・同プロジェクトは上書き）
 * milestone が指定されている場合: 同じ (project_id, milestone) のレコードが
 * 既に存在したらスキップ（既存idを返す）、存在しなければINSERT。
 * milestone が null の場合: 従来通り (project_id, record_date) でupsert。
 */
export function saveMetrics(db, projectId, data) {
  const milestone = data.milestone ?? null;

  if (milestone !== null) {
    // milestone指定: 既存チェック
    const existing = db.prepare(
      'SELECT id FROM cb_sales_records WHERE project_id=? AND milestone=?'
    ).get(projectId, milestone);
    if (existing) {
      return existing.id; // スキップ
    }
    return db.prepare(`INSERT INTO cb_sales_records
      (project_id, record_date, impressions, pv, likes, comments,
       purchase_count, revenue, price, memo, source, milestone)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      projectId, data.date,
      data.impressions ?? null, data.pv ?? null, data.likes ?? null,
      data.comments ?? null, data.purchases ?? null, data.revenue ?? null,
      data.price ?? null, data.memo ?? null, data.source ?? 'manual',
      milestone
    ).lastInsertRowid;
  }

  // milestone null: 従来通り record_date でupsert
  const existing = db.prepare(
    'SELECT id FROM cb_sales_records WHERE project_id=? AND record_date=? AND milestone IS NULL'
  ).get(projectId, data.date);
  if (existing) {
    db.prepare(`UPDATE cb_sales_records SET
      impressions = COALESCE(?, impressions),
      pv          = COALESCE(?, pv),
      likes       = COALESCE(?, likes),
      comments    = COALESCE(?, comments),
      purchase_count = COALESCE(?, purchase_count),
      revenue     = COALESCE(?, revenue),
      price       = COALESCE(?, price),
      memo        = COALESCE(?, memo),
      source      = COALESCE(?, source),
      updated_at  = datetime('now','localtime')
      WHERE id = ?`).run(
      data.impressions ?? null, data.pv ?? null, data.likes ?? null,
      data.comments ?? null, data.purchases ?? null, data.revenue ?? null,
      data.price ?? null, data.memo ?? null, data.source ?? null,
      existing.id
    );
    return existing.id;
  } else {
    return db.prepare(`INSERT INTO cb_sales_records
      (project_id, record_date, impressions, pv, likes, comments,
       purchase_count, revenue, price, memo, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      projectId, data.date,
      data.impressions ?? null, data.pv ?? null, data.likes ?? null,
      data.comments ?? null, data.purchases ?? null, data.revenue ?? null,
      data.price ?? null, data.memo ?? null, data.source ?? 'manual'
    ).lastInsertRowid;
  }
}

/**
 * メトリクス履歴を取得
 */
export function listMetrics(db, projectId) {
  return db.prepare(
    'SELECT * FROM cb_sales_records WHERE project_id=? ORDER BY record_date ASC'
  ).all(projectId);
}

/**
 * メトリクスサマリーを計算（差分・マイルストーン含む）
 */
export function getMetricsSummary(db, projectId) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id=?').get(projectId);
  const records = db.prepare(
    'SELECT * FROM cb_sales_records WHERE project_id=? ORDER BY record_date ASC'
  ).all(projectId);

  const publishedAt = project.published_at || null;
  let daysSincePublish = null;
  if (publishedAt) {
    const pub = new Date(publishedAt);
    const now = new Date();
    daysSincePublish = Math.floor((now - pub) / 86400000);
  }

  const latest   = records.length > 0 ? records[records.length - 1] : null;
  const previous = records.length > 1 ? records[records.length - 2] : null;

  const calcDiff = (a, b) => (a != null && b != null) ? a - b : null;
  const diff = (latest && previous) ? {
    impressions: calcDiff(latest.impressions, previous.impressions),
    pv:          calcDiff(latest.pv, previous.pv),
    likes:       calcDiff(latest.likes, previous.likes),
    comments:    calcDiff(latest.comments, previous.comments),
    purchases:   calcDiff(latest.purchase_count, previous.purchase_count),
    revenue:     calcDiff(latest.revenue, previous.revenue),
  } : null;

  // マイルストーンスナップショットを探す（旧来互換）
  const findDaySnapshot = (targetDay) => {
    if (!publishedAt) return null;
    const pubDate = new Date(publishedAt);
    pubDate.setDate(pubDate.getDate() + targetDay);
    const targetDateStr = pubDate.toISOString().slice(0, 10);
    // ±1日以内の最も近いレコードを返す
    return records.find(r => r.record_date === targetDateStr)
      || records.find(r => Math.abs(new Date(r.record_date) - pubDate) <= 86400000)
      || null;
  };

  const milestones = {
    day3: {
      due: daysSincePublish != null && daysSincePublish >= 3,
      snapshot: findDaySnapshot(3),
    },
    day7: {
      due: daysSincePublish != null && daysSincePublish >= 7,
      snapshot: findDaySnapshot(7),
    },
  };

  // initialRecord: milestone='INITIAL' のレコード
  const initialRecord = db.prepare(
    "SELECT * FROM cb_sales_records WHERE project_id=? AND milestone='INITIAL'"
  ).get(projectId) || null;

  // pendingMilestones: 期限超過かつ未入力のマイルストーン
  const pendingMilestones = [];
  if (publishedAt && daysSincePublish != null) {
    const hasMilestone = (ms) => records.some(r => r.milestone === ms);
    if (daysSincePublish >= 3  && !hasMilestone('DAY3'))  pendingMilestones.push('DAY3');
    if (daysSincePublish >= 7  && !hasMilestone('DAY7'))  pendingMilestones.push('DAY7');
    if (daysSincePublish >= 30 && !hasMilestone('DAY30')) pendingMilestones.push('DAY30');
  }

  // fromInitialDiff: latest vs initialRecord の差分
  let fromInitialDiff = null;
  if (initialRecord) {
    const fields = ['impressions', 'pv', 'likes', 'comments', 'purchase_count', 'revenue'];
    fromInitialDiff = {};
    for (const f of fields) {
      const base = initialRecord[f];
      const cur  = latest?.[f];
      const d = (cur != null && base != null) ? cur - base : null;
      const rate = (d != null && base != null && base !== 0) ? Math.round(d / base * 100) : null;
      fromInitialDiff[f] = { diff: d, rate };
    }
  }

  return {
    project,
    records: [...records].reverse(), // 新しい順
    latest,
    previous,
    diff,
    daysSincePublish,
    milestones,
    publishedAt,
    initialRecord,
    pendingMilestones,
    fromInitialDiff,
  };
}

/**
 * note公式CSVをインポート
 * note売上管理CSVフォーマット:
 *   購入日時, タイトル, 記事URL, 購入者ID, 購入金額(円), システム利用料(円), 振込予定金額(円)
 */
export function importMetricsCSV(db, csvText) {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) throw new Error('CSVが空です');

  // URLでプロジェクトを引く
  const projectsByUrl = {};
  const projects = db.prepare("SELECT id, note_url FROM cb_projects WHERE note_url IS NOT NULL").all();
  for (const p of projects) {
    if (p.note_url) projectsByUrl[p.note_url.trim()] = p.id;
  }

  // ヘッダー行を検出してカラムインデックスを特定
  const header = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const findCol = (...names) => {
    for (const name of names) {
      const idx = header.findIndex(h => h.includes(name));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const idxDate     = findCol('購入日時', '日時', 'date');
  const idxUrl      = findCol('記事URL', 'URL', 'url');
  const idxAmount   = findCol('購入金額', '金額', 'amount');
  if (idxDate < 0 || idxUrl < 0 || idxAmount < 0) {
    throw new Error('CSVフォーマットが認識できません（購入日時・記事URL・購入金額 が必要）');
  }

  // 行をパースして (date, projectId) 単位で集計
  const aggregated = {}; // key: "date|projectId"
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const dateRaw = cols[idxDate] ?? '';
    const urlRaw  = cols[idxUrl]  ?? '';
    const amount  = parseInt(cols[idxAmount] ?? '0') || 0;

    const date = dateRaw.slice(0, 10); // YYYY-MM-DD
    const url  = urlRaw.replace(/[?#].*$/, '').replace(/\/$/, ''); // normalize

    const projectId = projectsByUrl[url] ?? null;
    if (!projectId) { skipped++; continue; }

    const key = `${date}|${projectId}`;
    if (!aggregated[key]) aggregated[key] = { date, projectId, purchases: 0, revenue: 0 };
    aggregated[key].purchases++;
    aggregated[key].revenue += amount;
  }

  // 集計結果をDBへ保存
  const saved = [];
  for (const entry of Object.values(aggregated)) {
    const id = saveMetrics(db, entry.projectId, {
      date: entry.date,
      purchases: entry.purchases,
      revenue: entry.revenue,
      source: 'csv',
    });
    saved.push({ ...entry, id });
  }

  return { saved: saved.length, skipped };
}

/**
 * アオによるメトリクス分析（AI）
 */
export async function analyzeMetrics(db, projectId) {
  const summary = getMetricsSummary(db, projectId);
  const project = summary.project;
  return runMetricsAnalysis({ summary, project });
}

/**
 * 公開済みとしてマーク + note情報を保存
 */
/**
 * 公開日時のみを更新（本文・ステータス・販売データは変更しない）
 */
export function setPublishedAt(db, projectId, publishedAt) {
  if (!publishedAt) throw new Error('published_at が必要です');
  db.prepare(`UPDATE cb_projects SET
    published_at = ?,
    updated_at = datetime('now','localtime')
    WHERE id = ?`).run(publishedAt, projectId);
}

export function markPublishedWithInfo(db, projectId, { noteUrl, publishedAt, price } = {}) {
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!['APPROVED'].includes(project?.status)) {
    throw new Error('APPROVED ステータスのプロジェクトのみ公開済みにできます');
  }
  db.prepare(`UPDATE cb_projects SET
    status = 'PUBLISHED',
    note_url = COALESCE(?, note_url),
    published_at = COALESCE(?, published_at),
    current_price = COALESCE(?, current_price),
    updated_at = datetime('now','localtime')
    WHERE id = ?`).run(noteUrl ?? null, publishedAt ?? null, price ?? null, projectId);
}

// ── Chat機能 ─────────────────────────────────────────────────────────────────

/**
 * Chatセッションを作成または取得
 */
export function getOrCreateChatSession(db, projectId, empId, sessionType = 'EMPLOYEE') {
  // 同じプロジェクト+社員の既存セッションを探す
  const existing = db.prepare(`
    SELECT id FROM cb_chat_sessions
    WHERE project_id ${projectId ? '= ?' : 'IS NULL'} AND employee_id = ? AND session_type = ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(...(projectId ? [projectId, empId, sessionType] : [empId, sessionType]));

  if (existing) return existing.id;

  return db.prepare(`
    INSERT INTO cb_chat_sessions (project_id, employee_id, session_type)
    VALUES (?, ?, ?)
  `).run(projectId ?? null, empId, sessionType).lastInsertRowid;
}

/**
 * 会議セッションを作成
 */
export function createMeetingSession(db, projectId, topic) {
  return db.prepare(`
    INSERT INTO cb_chat_sessions (project_id, employee_id, session_type, topic)
    VALUES (?, 'MEETING', 'MEETING', ?)
  `).run(projectId ?? null, topic ?? '編集会議').lastInsertRowid;
}

/**
 * チャット履歴を取得
 */
export function getChatHistory(db, sessionId, limit = 20) {
  return db.prepare(`
    SELECT speaker, message, created_at FROM cb_chat_messages
    WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(sessionId, limit).reverse();
}

/**
 * チャットメッセージを保存
 */
export function saveChatMessage(db, sessionId, speaker, message, metadata = null) {
  db.prepare(`
    INSERT INTO cb_chat_messages (session_id, speaker, message, metadata_json)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, speaker, message, metadata ? JSON.stringify(metadata) : null);
  db.prepare(`UPDATE cb_chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(sessionId);
}

/**
 * 社員ごとのコンテキストを構築（担当範囲の情報のみ）
 */
export function buildEmployeeContext(db, projectId, empId) {
  if (!projectId) return '';
  const project = db.prepare('SELECT * FROM cb_projects WHERE id = ?').get(projectId);
  if (!project) return '';

  const base = `プロジェクト: ${project.theme ?? project.genre ?? `#${projectId}`}\n状態: ${project.status}`;

  if (empId === 'Scout') {
    const items = db.prepare('SELECT url, title, fetch_ok, fetch_error FROM cb_research_items WHERE project_id = ?').all(projectId);
    const ok   = items.filter(r => r.fetch_ok === 1).length;
    const fail = items.filter(r => r.fetch_ok === 0).length;
    return `${base}\n調査件数: ${items.length}件（成功${ok}件・失敗${fail}件）`;
  }

  if (empId === 'Analyst') {
    const resCount = db.prepare('SELECT COUNT(*) as cnt FROM cb_research_items WHERE project_id = ?').get(projectId)?.cnt ?? 0;
    const analysisJob = db.prepare(`SELECT result_json FROM cb_jobs WHERE project_id = ? AND job_type = 'ANALYSIS' AND status = 'DONE' ORDER BY finished_at DESC LIMIT 1`).get(projectId);
    const analysisText = analysisJob?.result_json ? JSON.parse(analysisJob.result_json)?.analysis_summary?.slice(0, 300) ?? '' : '';
    return `${base}\n調査件数: ${resCount}件\n分析結果（要約）: ${analysisText || '（未分析）'}`;
  }

  if (empId === 'Planner') {
    const ideas = db.prepare('SELECT idea_index, title, target_reader, uniqueness FROM cb_ideas WHERE project_id = ?').all(projectId);
    const ideaText = ideas.map(i => `案${i.idea_index}: ${i.title ?? '—'} / 読者: ${i.target_reader ?? '—'}`).join('\n');
    return `${base}\n選択案: ${project.selected_idea_index ? `案${project.selected_idea_index}` : '未選択'}\n企画案:\n${ideaText || '（未作成）'}`;
  }

  if (empId === 'Writer') {
    const idea = db.prepare('SELECT * FROM cb_ideas WHERE project_id = ? AND idea_index = ?').get(projectId, project.selected_idea_index ?? 1);
    const draft = db.prepare('SELECT title_candidates, lead, summary FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId);
    const titles = draft?.title_candidates ? JSON.parse(draft.title_candidates).slice(0, 3).join(', ') : '—';
    return `${base}\n採用案: ${idea?.title ?? '—'}\nタイトル候補: ${titles}\nリード（先頭100字）: ${(draft?.lead ?? '').slice(0, 100)}`;
  }

  if (empId === 'Editor') {
    const draft = db.prepare('SELECT title_candidates, editor_verdict, editor_notes, revision_request FROM cb_article_drafts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId);
    return `${base}\n編集判定: ${draft?.editor_verdict ?? '（未チェック）'}\n編集メモ: ${(draft?.editor_notes ?? '').slice(0, 200)}\n修正要求: ${(draft?.revision_request ?? '').slice(0, 100)}`;
  }

  if (empId === 'Growth') {
    const sales = db.prepare('SELECT record_date, pv, purchase_count, revenue, price FROM cb_sales_records WHERE project_id = ? ORDER BY record_date DESC LIMIT 5').all(projectId);
    const salesText = sales.map(s => `${s.record_date}: PV${s.pv ?? '—'} 購入${s.purchase_count ?? '—'} ¥${s.revenue ?? '—'}`).join('\n');
    return `${base}\n売上データ:\n${salesText || '（データなし）'}`;
  }

  return base;
}

/**
 * 社員とのChatを処理（メッセージ保存込み）
 * Writer（ソラ）の場合は記事生成意図を検出し、ドラフトを保存する
 */
export async function processChatMessage(db, sessionId, empId, userMessage, projectId, { chatMode = 'casual' } = {}) {
  // メッセージ保存
  saveChatMessage(db, sessionId, '社長', userMessage);

  // 会話履歴取得（直近10件）
  const history = getChatHistory(db, sessionId, 10);
  const historyWithoutLast = history.slice(0, -1);

  // コンテキスト構築（業務モードのみ。雑談モードはcontext不要）
  const contextText = (chatMode === 'work' && projectId) ? buildEmployeeContext(db, projectId, empId) : '';

  // ── ソラ（Writer）専用: 記事生成意図の検出（業務モードのみ）────────────────
  if (empId === 'Writer' && chatMode === 'work') {
    const result = await runWriterFromChat(userMessage, contextText, historyWithoutLast);

    if (result.is_article && result.article) {
      // ドラフトをDBに保存
      const draftId = saveChatDraft(db, {
        sessionId,
        projectId: projectId ?? null,
        article: result.article,
      });

      const reply = result.chat_reply ?? 'ことりさん、初稿を保存しました。';
      saveChatMessage(db, sessionId, empId, reply, { draft_id: draftId, type: 'article_created' });
      return { reply, sessionId, draft_id: draftId, has_draft: true };
    }

    // 記事生成でない場合: 通常チャット返答
    const reply = result.chat_reply;
    saveChatMessage(db, sessionId, empId, reply);
    return { reply, sessionId };
  }

  // ── その他の社員: 通常チャット ─────────────────────────────────────────
  const reply = await runEmployeeChat(empId, userMessage, contextText, historyWithoutLast, { chatMode });
  saveChatMessage(db, sessionId, empId, reply);
  return { reply, sessionId };
}

// ── Chat起点ドラフト（cb_chat_drafts）関連 ───────────────────────────────────

/**
 * Chatから生成された記事ドラフトを保存
 */
export function saveChatDraft(db, { sessionId, projectId, article, parentDraftId = null, version = 1, revisionInstruction = null }) {
  const fc = article.full_content ?? [article.lead, article.free_part, article.paid_part, article.summary].filter(Boolean).join('\n\n');
  const wordCount = fc.length;

  const result = db.prepare(`
    INSERT INTO cb_chat_drafts
      (project_id, chat_session_id, parent_draft_id, version,
       title, lead, free_part, paid_part, summary, full_content, word_count,
       created_by, status, revision_instruction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Writer', 'DRAFT', ?)
  `).run(
    projectId ?? null, sessionId, parentDraftId ?? null, version,
    article.title ?? null, article.lead ?? null,
    article.free_part ?? null, article.paid_part ?? null,
    article.summary ?? null, fc, wordCount,
    revisionInstruction ?? null,
  );
  return result.lastInsertRowid;
}

/**
 * ドラフト単件取得
 */
export function getChatDraft(db, draftId) {
  return db.prepare('SELECT * FROM cb_chat_drafts WHERE id = ?').get(draftId);
}

/**
 * ドラフト一覧（セッションまたはプロジェクト単位）
 */
export function listChatDrafts(db, { sessionId, projectId } = {}) {
  if (sessionId) {
    return db.prepare('SELECT * FROM cb_chat_drafts WHERE chat_session_id = ? ORDER BY created_at DESC').all(sessionId);
  }
  if (projectId) {
    return db.prepare('SELECT * FROM cb_chat_drafts WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  }
  return [];
}

/**
 * ドラフトを修正してv+1 で保存
 */
export async function reviseChatDraft(db, draftId, revisionInstruction, sessionId) {
  const original = getChatDraft(db, draftId);
  if (!original) throw new Error(`ドラフト #${draftId} が見つかりません`);

  const existingSummary = `タイトル: ${original.title ?? '—'}\nリード: ${(original.lead ?? '').slice(0, 200)}\n本文（先頭200字）: ${(original.full_content ?? '').slice(0, 200)}`;

  const result = await runWriterFromChat(
    `以下の修正指示に従って、記事を修正してください:\n${revisionInstruction}`,
    '',
    [],
    revisionInstruction,
    existingSummary,
  );

  if (!result.is_article || !result.article) {
    throw new Error('ソラが記事として返答しませんでした。修正指示をより具体的にしてください。');
  }

  const newVersion = (original.version ?? 1) + 1;
  const newDraftId = saveChatDraft(db, {
    sessionId,
    projectId: original.project_id,
    article: result.article,
    parentDraftId: draftId,
    version: newVersion,
    revisionInstruction,
  });

  // チャットにも記録
  if (sessionId) {
    const reply = result.chat_reply ?? `ことりさん、v${newVersion}に更新しました。`;
    saveChatMessage(db, sessionId, 'Writer', reply, { draft_id: newDraftId, type: 'article_revised', version: newVersion });
  }

  return { draft_id: newDraftId, version: newVersion, reply: result.chat_reply };
}

/**
 * ドラフトをキイロ（Editor）に送る
 */
export async function sendDraftToEditor(db, draftId, sessionId) {
  const draft = getChatDraft(db, draftId);
  if (!draft) throw new Error(`ドラフト #${draftId} が見つかりません`);

  // キイロのrunEditorを呼ぶ（selectedIdeaはダミー、fullContentを使う）
  const { runEditor } = await import('./ai_worker.mjs');
  const editorResult = await runEditor({
    draft: {
      title_candidates: draft.title ? [draft.title] : [],
      lead: draft.lead ?? '',
      free_part: draft.free_part ?? '',
      paid_part: draft.paid_part ?? '',
      summary: draft.summary ?? '',
    },
    selectedIdea: { title: draft.title ?? '', target_reader: '—', problem: '—', value: '—', uniqueness: '—' },
  });

  // 結果を保存
  db.prepare('UPDATE cb_chat_drafts SET editor_verdict = ?, editor_notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    editorResult?.verdict ?? 'REVISION_REQUIRED',
    editorResult?.notes ?? '',
    'EDITOR_CHECK',
    draftId,
  );

  // キイロの返答をチャットに記録
  if (sessionId) {
    const verdictMsg = editorResult?.verdict === 'READY'
      ? `山吹社長、編集チェックが完了しました。${editorResult.notes?.slice(0, 100) ?? ''}`
      : `山吹社長、${editorResult?.notes?.slice(0, 150) ?? '修正が必要な箇所があります。'}`;
    saveChatMessage(db, sessionId, 'Editor', verdictMsg, { draft_id: draftId, type: 'editor_check', verdict: editorResult?.verdict });
  }

  return editorResult;
}

/**
 * AI編集会議を実行（全6人）
 */
// ── ナレッジ管理 (cb_editorial_learnings) ─────────────────────────────────────

const VALID_KNOWLEDGE_CATEGORIES = ['FACT', 'PRIVACY', 'STYLE', 'EDITORIAL_RULE', 'ARTICLE_SPECIFIC', 'REJECTED'];
const VALID_APPROVAL_STATUSES    = ['approved', 'pending', 'rejected_by_owner'];

export function listKnowledge(db, { category = null, approval_status = null, is_active = null } = {}) {
  const conditions = ['1=1'];
  const params = [];
  if (category)           { conditions.push('category = ?');        params.push(category); }
  if (approval_status)    { conditions.push('approval_status = ?'); params.push(approval_status); }
  if (is_active !== null) { conditions.push('is_active = ?');       params.push(is_active ? 1 : 0); }
  return db.prepare(
    `SELECT * FROM cb_editorial_learnings WHERE ${conditions.join(' AND ')} ORDER BY category, id`
  ).all(...params);
}

export function createKnowledge(db, { category, rule_text, source_type = 'owner_explicit', source_project_id = null, trust_level = 'owner_explicit', approval_status = 'approved' }) {
  if (!VALID_KNOWLEDGE_CATEGORIES.includes(category)) throw new Error(`不正なカテゴリ: ${category}`);
  if (!rule_text?.trim()) throw new Error('rule_text は必須です');
  const r = db.prepare(`
    INSERT INTO cb_editorial_learnings
      (category, rule_text, source_type, source_project_id, trust_level, approval_status, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(category, rule_text.trim(), source_type, source_project_id ?? null, trust_level, approval_status);
  return r.lastInsertRowid;
}

export function updateKnowledge(db, id, { rule_text, approval_status, is_active } = {}) {
  const fields = [];
  const params = [];
  if (rule_text !== undefined) {
    fields.push('rule_text = ?');
    params.push(rule_text.trim());
  }
  if (approval_status !== undefined) {
    if (!VALID_APPROVAL_STATUSES.includes(approval_status)) throw new Error(`不正なapproval_status: ${approval_status}`);
    fields.push('approval_status = ?');
    params.push(approval_status);
    // owner が approved にした場合は trust_level を owner_approved に昇格
    if (approval_status === 'approved') {
      fields.push('trust_level = ?');
      params.push('owner_approved');
    }
  }
  if (is_active !== undefined) {
    fields.push('is_active = ?');
    params.push(is_active ? 1 : 0);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = datetime('now','localtime')`);
  params.push(Number(id));
  db.prepare(`UPDATE cb_editorial_learnings SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteKnowledge(db, id) {
  db.prepare('DELETE FROM cb_editorial_learnings WHERE id = ?').run(Number(id));
}

/**
 * approved かつ active なナレッジを取得（AI プロンプト注入用）
 * ARTICLE_SPECIFIC はデフォルト除外（グローバルルールへの自動昇格禁止）
 */
export function loadApprovedKnowledge(db, { includeArticleSpecific = false } = {}) {
  let sql = `SELECT * FROM cb_editorial_learnings WHERE approval_status = 'approved' AND is_active = 1`;
  if (!includeArticleSpecific) sql += ` AND category != 'ARTICLE_SPECIFIC'`;
  sql += ` ORDER BY category, id`;
  return db.prepare(sql).all();
}

export async function processEditorialMeeting(db, sessionId, topic, projectId) {
  saveChatMessage(db, sessionId, '社長', `【会議開始】テーマ: ${topic}`);

  const projectContext = projectId ? buildEmployeeContext(db, projectId, 'Planner') : '';
  const responses = await runEditorialMeeting(topic, projectContext);

  for (const r of responses) {
    saveChatMessage(db, sessionId, r.empId, r.message, { role: r.role, name: r.name });
  }

  // 最後に会議まとめ（アサヒが担当）
  const summaryLines = responses.map(r => `${r.name}：${r.message}`).join('\n\n');
  const summaryPrompt = `以下はAI編集会議の発言です。論点を2〜3点にまとめ、最後に「社長、どの方向で進めますか？」で終えてください。決定はせず、提案として伝えてください。\n\n${summaryLines}`;

  const summary = await runEmployeeChat('Planner', summaryPrompt, projectContext, []);
  saveChatMessage(db, sessionId, 'Planner', `【会議まとめ】\n${summary}`, { isSummary: true });

  return { responses, summary, sessionId };
}
