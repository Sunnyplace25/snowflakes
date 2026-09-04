#!/usr/bin/env python3
"""
JARVIS 請求書生成スクリプト（ZIP直接操作方式 / 単一シート出力）

テンプレート Excel (.xlsx) を ZIP として扱い、★請求書マスターシートの
セル値だけを書き換え、そのシート 1 枚だけを含む .xlsx を出力する。

- スタイル・書式・罫線・フォント・結合セル・画像・列幅・行高・印刷範囲を
  一切変更せず 100% 保持（openpyxl の再マッピングを経由しない）
- 数式セルは上書きしない（Excel 起動時に自動再計算）
- 文字列は inline string (t="inlineStr") として書き込む
  → shared strings 再インデックス問題を回避
- テンプレートファイル自体は変更しない
- 出力は★請求書マスター 1 シートのみ（Excelが即座に請求書を表示する）

JSON 入力形式:
{
  "template_path": "...",
  "output_path":   "...",
  "month":         "2026-07",
  "invoice_number": "2026-07",
  "invoice_date":   "2026-07-31",
  "client":         "株式会社\u3000オーテック",
  "tax_rate":       10,
  "memo":           "2026年7月分としてご請求申し上げます。",
  "rows": [
    { "no":1, "date_label":"7/9", "description":"...",
      "quantity":1, "unit":"日", "unit_price":14500, "amount":14500 }
  ]
}
"""

import sys, json, os, shutil, zipfile, re, argparse, datetime, copy
import xml.etree.ElementTree as ET

# ─── Excel 名前空間 ────────────────────────────────────────────────────────────
NS   = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
RNS  = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PNS  = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

ET.register_namespace('',    NS)
ET.register_namespace('r',   RNS)
ET.register_namespace('mc',  'http://schemas.openxmlformats.org/markup-compatibility/2006')
ET.register_namespace('x14ac','http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac')

MASTER_SHEET      = '★請求書マスター'
DETAIL_ROW_START  = 17
DETAIL_ROW_END    = 36          # テンプレートの最終明細行（基準）
MAX_ROWS_BASE     = DETAIL_ROW_END - DETAIL_ROW_START + 1  # 20
MAX_ROWS          = 25          # 最大許容件数（5行拡張後）
EXPAND_DELTA      = MAX_ROWS - MAX_ROWS_BASE                # 5
SHIFT_FROM_ROW    = DETAIL_ROW_END + 1                      # 37（拡張時にシフト開始する行）

# ── 行拡張時スタイル定義 ───────────────────────────────────────────────────────
# 行36 の「最終行スタイル」→「内部スタイル」変換マップ（拡張時に行36を内部行化）
# item 20 は偶数 → 偶数行スタイル（I=164 → fix_sheet_layout で 111 に正規化）
LAST_ROW_TO_INTERIOR = {
    '169': '87',   # A
    '170': '149',  # B
    '171': '150',  # C
    # 172 (D,E,F) は C:G マージ内部で非表示 → そのまま
    '173': '126',  # G, K, M
    '174': '151',  # H
    '175': '164',  # I → fix_sheet_layout で 111（偶数）に正規化
    '176': '130',  # J, L
}

# 新規内部行スタイル（テンプレート行 34/35 から採用）
# 奇数行（item 21, 23）: rows 33/35 パターン — I=160 → 153 に正規化
NEW_ROW_ODD_STYLES = {
    'A': '87', 'B': '149', 'C': '150',
    'G': '126', 'H': '151', 'I': '160',
    'J': '130', 'K': '126', 'L': '130', 'M': '126',
}
# 偶数行（item 22, 24）: rows 34 パターン — I=164 → 111 に正規化
NEW_ROW_EVEN_STYLES = {
    'A': '87', 'B': '149', 'C': '150',
    'G': '126', 'H': '151', 'I': '164',
    'J': '130', 'K': '126', 'L': '130', 'M': '126',
}
# 最終行（item 25）: 行 36 と同一スタイル（I=188 Meiryo 13pt + 下ボーダー付き）
# I列のみ 175（Calibri 11pt）→ 188（Meiryo 13pt / borderId=62 / fillId=4 共通）に変更
# fix_sheet_layout の I_STYLE_MAP でも 175→188 に正規化されるため二重で安全
NEW_ROW_LAST_STYLES = {
    'A': '169', 'B': '170', 'C': '171', 'D': '172', 'E': '172', 'F': '172',
    'G': '173', 'H': '174', 'I': '188', 'J': '176', 'K': '173', 'L': '176', 'M': '173',
}

# 差し替える列（アルファベット → フィールド名）
DETAIL_COLS = {
    'A': 'no',
    'B': 'date_label',
    'C': 'description',
    'H': 'quantity',
    'I': 'unit',
    'J': 'unit_price',
    'L': 'amount',
}

# 文字列として書き込む列（A=no は数値、H=quantity は書式制御のため文字列、B/C/I も文字列）
DETAIL_STRING_COLS = {'B', 'C', 'H', 'I'}

# ─── ユーティリティ ────────────────────────────────────────────────────────────

def col_letter_to_num(letter):
    n = 0
    for c in letter.upper():
        n = n * 26 + (ord(c) - ord('A') + 1)
    return n

def cell_ref(col_letter, row):
    return f'{col_letter.upper()}{row}'

def date_to_excel_serial(date_str):
    """YYYY-MM-DD → Excel シリアル値（1900年基準、うるう年バグ込み）"""
    d = datetime.datetime.strptime(date_str, '%Y-%m-%d').date()
    epoch = datetime.date(1899, 12, 30)
    return (d - epoch).days

def find_sheet_info(z, sheet_name):
    """ワークブックの sheet_name に対応する (xl_path, rId) を返す"""
    wb_xml = ET.fromstring(z.read('xl/workbook.xml'))
    rels   = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rid_map = {r.get('Id'): r.get('Target') for r in rels}

    for sh in wb_xml.iter(f'{{{NS}}}sheet'):
        if sh.get('name') == sheet_name:
            rid    = sh.get(f'{{{RNS}}}id')
            target = rid_map.get(rid, '')
            if not target.startswith('/') and not target.startswith('xl/'):
                target = 'xl/' + target
            elif target.startswith('/'):
                target = target.lstrip('/')
            return target, rid
    return None, None

def discover_master_assets(z, sheet_path):
    """
    マスターシートの rels から drawing パスと media パスを収集して返す。
    Returns: (drawing_path, drawing_rels_path, media_paths: set)
    """
    # sheet の _rels ファイルパス
    # xl/worksheets/sheet9.xml → xl/worksheets/_rels/sheet9.xml.rels
    sheet_dir  = sheet_path.rsplit('/', 1)[0]   # xl/worksheets
    sheet_file = sheet_path.rsplit('/', 1)[1]    # sheet9.xml
    sheet_rels_path = f'{sheet_dir}/_rels/{sheet_file}.rels'

    drawing_path      = None
    drawing_rels_path = None
    media_paths       = set()

    if sheet_rels_path not in z.namelist():
        return drawing_path, drawing_rels_path, media_paths

    sheet_rels = ET.fromstring(z.read(sheet_rels_path))
    for rel in sheet_rels:
        rel_type = rel.get('Type', '')
        target   = rel.get('Target', '')
        if 'drawing' in rel_type:
            # Target は ../drawings/drawing9.xml (worksheets からの相対)
            drawing_file = target.split('/')[-1]               # drawing9.xml
            drawing_path = f'xl/drawings/{drawing_file}'
            drawing_rels_path = f'xl/drawings/_rels/{drawing_file}.rels'

    # drawing の rels から media を収集
    if drawing_rels_path and drawing_rels_path in z.namelist():
        drw_rels = ET.fromstring(z.read(drawing_rels_path))
        for rel in drw_rels:
            target = rel.get('Target', '')
            if '../media/' in target:
                media_file = target.split('/')[-1]
                media_paths.add(f'xl/media/{media_file}')

    return drawing_path, drawing_rels_path, media_paths

# ─── セル XML 操作 ────────────────────────────────────────────────────────────

def _find_or_create_row(sheet_root, row_num):
    """<sheetData> の中から指定行番号の <row> 要素を返す（なければ作成）"""
    sd = sheet_root.find(f'{{{NS}}}sheetData')
    for row_el in sd:
        if row_el.get('r') == str(row_num):
            return row_el
    new_row = ET.SubElement(sd, f'{{{NS}}}row', {'r': str(row_num)})
    rows = list(sd)
    rows.sort(key=lambda el: int(el.get('r', 0)))
    for r in rows:
        sd.remove(r)
    for r in rows:
        sd.append(r)
    return new_row

def _find_or_create_cell(row_el, ref):
    """<row> の中から ref の <c> 要素を返す（なければ作成）"""
    for c in row_el:
        if c.get('r') == ref:
            return c
    col_letter = re.match(r'([A-Z]+)', ref).group(1)
    col_num = col_letter_to_num(col_letter)
    new_c = ET.Element(f'{{{NS}}}c', {'r': ref})
    cells = list(row_el)
    cells.append(new_c)
    cells.sort(key=lambda el: col_letter_to_num(re.match(r'([A-Z]+)', el.get('r','')).group(1)))
    for c in list(row_el):
        row_el.remove(c)
    for c in cells:
        row_el.append(c)
    return new_c

def set_inline_string(sheet_root, ref, value):
    """セルを inline string として書き込む（書式スタイルは保持）"""
    row_num = int(re.search(r'(\d+)$', ref).group(1))
    row_el  = _find_or_create_row(sheet_root, row_num)
    c       = _find_or_create_cell(row_el, ref)

    for tag in [f'{{{NS}}}v', f'{{{NS}}}f', f'{{{NS}}}is']:
        old = c.find(tag)
        if old is not None:
            c.remove(old)

    c.set('t', 'inlineStr')
    is_el = ET.SubElement(c, f'{{{NS}}}is')
    t_el  = ET.SubElement(is_el, f'{{{NS}}}t')
    t_el.text = str(value)

def set_number(sheet_root, ref, value):
    """セルを数値として書き込む（書式スタイルは保持）"""
    row_num = int(re.search(r'(\d+)$', ref).group(1))
    row_el  = _find_or_create_row(sheet_root, row_num)
    c       = _find_or_create_cell(row_el, ref)

    for tag in [f'{{{NS}}}v', f'{{{NS}}}f', f'{{{NS}}}is']:
        old = c.find(tag)
        if old is not None:
            c.remove(old)

    c.attrib.pop('t', None)
    v_el = ET.SubElement(c, f'{{{NS}}}v')
    v_el.text = str(value)

def set_date(sheet_root, ref, date_str):
    """セルを日付シリアル値として書き込む（書式スタイルは保持）"""
    set_number(sheet_root, ref, date_to_excel_serial(date_str))

def clear_cell(sheet_root, ref):
    """セルの値だけをクリア（書式スタイルは保持）"""
    row_num = int(re.search(r'(\d+)$', ref).group(1))
    sd = sheet_root.find(f'{{{NS}}}sheetData')
    for row_el in sd:
        if row_el.get('r') == str(row_num):
            for c in row_el:
                if c.get('r') == ref:
                    for tag in [f'{{{NS}}}v', f'{{{NS}}}f', f'{{{NS}}}is']:
                        old = c.find(tag)
                        if old is not None:
                            c.remove(old)
                    c.attrib.pop('t', None)
                    return

def is_formula_cell(sheet_root, ref):
    """セルが数式かどうか確認"""
    row_num = int(re.search(r'(\d+)$', ref).group(1))
    sd = sheet_root.find(f'{{{NS}}}sheetData')
    for row_el in sd:
        if row_el.get('r') == str(row_num):
            for c in row_el:
                if c.get('r') == ref:
                    return c.find(f'{{{NS}}}f') is not None
    return False

# ─── ZIP XML 書き換え ─────────────────────────────────────────────────────────

def rewrite_workbook_xml(wb_xml_bytes, master_rid, new_sheet_name):
    """
    workbook.xml を書き換えて：
    1. マスターシート以外の <sheet> 要素を削除
    2. マスターシートの sheetId を "1" に変更
    3. workbookView の activeTab を "0" に設定
    """
    root = ET.fromstring(wb_xml_bytes)

    # <sheets> の中からマスター以外を削除
    sheets_el = root.find(f'{{{NS}}}sheets')
    if sheets_el is not None:
        to_remove = []
        master_el = None
        for sh in list(sheets_el):
            if sh.get(f'{{{RNS}}}id') == master_rid:
                master_el = sh
            else:
                to_remove.append(sh)
        for sh in to_remove:
            sheets_el.remove(sh)
        # マスターシートの属性を整理
        if master_el is not None:
            master_el.set('name', new_sheet_name)
            master_el.set('sheetId', '1')

    # workbookView の activeTab を 0 に設定（最初のシートを表示）
    for wbv in root.iter(f'{{{NS}}}workbookView'):
        wbv.set('activeTab', '0')

    return (b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            + ET.tostring(root, encoding='unicode').encode('utf-8'))

def rewrite_workbook_rels(rels_xml_bytes, master_rid):
    """
    workbook.xml.rels を書き換えて、worksheet タイプのリレーションを
    マスターシート (master_rid) 以外すべて削除する。
    """
    WS_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
    root = ET.fromstring(rels_xml_bytes)
    to_remove = []
    for rel in list(root):
        if rel.get('Type') == WS_TYPE and rel.get('Id') != master_rid:
            to_remove.append(rel)
    for rel in to_remove:
        root.remove(rel)
    return (b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            + ET.tostring(root, encoding='unicode').encode('utf-8'))

def rewrite_content_types(ct_xml_bytes, keep_sheet_path, keep_drawing_path):
    """
    [Content_Types].xml を書き換えて、除外するシート・描画の Override を削除する。
    keep_sheet_path   例: 'xl/worksheets/sheet9.xml'
    keep_drawing_path 例: 'xl/drawings/drawing9.xml'  (None の場合は全描画をスキップ)
    """
    WS_CT  = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
    DRW_CT = 'application/vnd.openxmlformats-officedocument.drawing+xml'

    root = ET.fromstring(ct_xml_bytes)
    to_remove = []
    for override in list(root):
        ct   = override.get('ContentType', '')
        part = override.get('PartName', '').lstrip('/')  # /xl/... → xl/...
        if ct == WS_CT and part != keep_sheet_path:
            to_remove.append(override)
        elif ct == DRW_CT:
            if keep_drawing_path is None or part != keep_drawing_path:
                to_remove.append(override)
    for el in to_remove:
        root.remove(el)

    # ElementTree が xmlns を付与しないよう register
    ET.register_namespace('', CT_NS)
    return (b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            + ET.tostring(root, encoding='unicode').encode('utf-8'))

def rewrite_styles_xml(styles_bytes):
    """
    styles.xml を最小限変更（テンプレートは変更しない、生成ファイルのみ適用）：
    - xf[199]: shrinkToFit="1" 追加（I39 消費税相当額）
    - 末尾に新規 xf 追加: xf[188] の clone, fillId="0"（I列 奇数最終行用）

    H列（xf[151]/xf[174]）のアラインメントは元の right のまま維持する。
    H=右寄せ / I=左寄せ で「1日」がひとまとまりに見える自然な配置を保つ。

    ※ xf[26] (A5 請求先名) は原本に shrinkToFit なし → 追加しない
    ※ xf[52] (I9 発行者名)  は narrow 列からオーバーフロー表示前提 → 追加しない
       （shrinkToFit を入れると I列=6.86幅に17ptの文字が4pt以下まで縮小される）
    """
    root = ET.fromstring(styles_bytes)
    xfs = root.find(f'{{{NS}}}cellXfs')
    if xfs is not None:
        xf_list = list(xfs)

        # xf[199] の alignment に shrinkToFit を追加
        idx = 199
        if idx < len(xf_list):
            xf = xf_list[idx]
            al = xf.find(f'{{{NS}}}alignment')
            if al is None:
                al = ET.SubElement(xf, f'{{{NS}}}alignment')
            al.set('shrinkToFit', '1')
            xf.set('applyAlignment', '1')

        # xf[188] の clone を末尾追加: fillId="0"（奇数最終行 I列用）
        src_idx = 188
        if src_idx < len(xf_list):
            new_xf = copy.deepcopy(xf_list[src_idx])
            new_xf.set('fillId', '0')
            new_xf.set('applyFill', '1')
            xfs.append(new_xf)
            xfs.set('count', str(len(list(xfs))))

    return (b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            + ET.tostring(root, encoding='unicode').encode('utf-8'))


def fix_sheet_layout(sheet_root, effective_end=None):
    """
    シート XML にレイアウト調整を適用する（テンプレートは変更しない）：
    1. G列（col 7）の幅を拡張 → C:G マージの内容列を広げる
    2. J列（col 10）の幅を 8.71 → 10.5 に拡張
       → I39:J39 マージで「消費税相当額」（7文字）が収まるよう調整
    3. 9行目の行高を 18.75 → 24.0 に拡張
       → I9 発行者名（17pt Meiryo）の垂直クリップを防ぐ
    """
    G_WIDTH = '30.0'   # C:G マージ内容列の G 列幅（折り返しなしで長い内容を表示）
    J_WIDTH = '10.5'

    cols_el = sheet_root.find(f'{{{NS}}}cols')
    if cols_el is not None:
        to_remove = []
        to_add = []
        for col in list(cols_el):
            mn = int(col.get('min', 0))
            mx = int(col.get('max', 0))
            w  = col.get('width', '')

            # G列 = col 7 を含む範囲を分割して幅を設定
            if mn <= 7 <= mx and mn != mx:
                to_remove.append(col)
                if mn <= 6:
                    to_add.append(ET.Element(f'{{{NS}}}col', {
                        'customWidth': col.get('customWidth', '1'),
                        'min': str(mn), 'max': '6', 'width': w,
                    }))
                to_add.append(ET.Element(f'{{{NS}}}col', {
                    'customWidth': '1', 'min': '7', 'max': '7', 'width': G_WIDTH,
                }))
                if mx >= 8:
                    to_add.append(ET.Element(f'{{{NS}}}col', {
                        'customWidth': col.get('customWidth', '1'),
                        'min': '8', 'max': str(mx), 'width': w,
                    }))
            elif mn == 7 and mx == 7:
                col.set('width', G_WIDTH)

            # J列 = col 10 を含む範囲を分割して幅を設定
            elif mn <= 10 <= mx and mn != mx:
                to_remove.append(col)
                if mn <= 9:
                    to_add.append(ET.Element(f'{{{NS}}}col', {
                        'customWidth': col.get('customWidth', '1'),
                        'min': str(mn), 'max': '9', 'width': w,
                    }))
                to_add.append(ET.Element(f'{{{NS}}}col', {
                    'customWidth': '1', 'min': '10', 'max': '10', 'width': J_WIDTH,
                }))
                if mx >= 11:
                    to_add.append(ET.Element(f'{{{NS}}}col', {
                        'customWidth': col.get('customWidth', '1'),
                        'min': '11', 'max': str(mx), 'width': w,
                    }))
            elif mn == 10 and mx == 10:
                col.set('width', J_WIDTH)

        for col in to_remove:
            cols_el.remove(col)
        for col in to_add:
            cols_el.append(col)
        # col 要素を min 順にソート
        cols_sorted = sorted(list(cols_el), key=lambda c: int(c.get('min', 0)))
        for c in list(cols_el):
            cols_el.remove(c)
        for c in cols_sorted:
            cols_el.append(c)

    # 2. 9行目の行高を拡張
    sd = sheet_root.find(f'{{{NS}}}sheetData')
    if sd is not None:
        for row_el in sd:
            if row_el.get('r') == '9':
                row_el.set('ht', '24.0')
                row_el.set('customHeight', '1')
                break

    if effective_end is None:
        effective_end = DETAIL_ROW_END

    # 3. 明細セルのスタイル正規化（テンプレート起因の異常スタイルを修正）
    #
    # 3a. I 列（単位）: Meiryo 13pt に統一
    #     テンプレートは行 25 以降で I 列が xf[160]/[164]（Calibri 11pt）に切り替わる。
    #     また row 32 は xf[168]（Calibri 11pt / blue fill）が残存する。
    #     拡張後の新規行（37〜40）も同様に対象に含める。
    #     160 → 153（奇数行・Meiryo 13pt・fill なし）
    #     164 → 111（偶数行・Meiryo 13pt・fill あり）
    #     168 → 111（偶数行・Calibri 残存を Meiryo 13pt に修正）
    #     175 → 188（最終行・Meiryo 13pt + 下ボーダー）
    I_STYLE_MAP = {'160': '153', '164': '111', '168': '111', '175': '188'}
    if sd is not None:
        for row_el in sd:
            rn = int(row_el.get('r', 0))
            if DETAIL_ROW_START <= rn <= effective_end:
                for c in row_el:
                    ref = c.get('r', '')
                    if ref.startswith('I') and ref[1:] == str(rn):
                        cur_s = c.get('s', '')
                        if cur_s in I_STYLE_MAP:
                            c.set('s', I_STYLE_MAP[cur_s])

    # 3b. B/C 列: テンプレート row 29（13件目）に赤文字スタイルが混入している
    #     xf[165]（B 赤 Meiryo 11pt）→ xf[149]（B 通常奇数）
    #     xf[166]（C 赤 Meiryo 11pt）→ xf[150]（C 通常奇数）
    BC_STYLE_MAP = {'165': '149', '166': '150'}
    if sd is not None:
        for row_el in sd:
            rn = int(row_el.get('r', 0))
            if DETAIL_ROW_START <= rn <= effective_end:
                for c in row_el:
                    ref = c.get('r', '')
                    col_m = re.match(r'^([A-Z]+)', ref)
                    if col_m and col_m.group(1) in ('B', 'C'):
                        cur_s = c.get('s', '')
                        if cur_s in BC_STYLE_MAP:
                            c.set('s', BC_STYLE_MAP[cur_s])


def _update_formula_refs(formula, delta, shift_from, old_end):
    """
    数式内のセル参照を行挿入後に更新する。
    - row >= shift_from のセル参照を +delta
    - old_end（旧最終明細行=36）への参照は new_end（41）へ拡張
    """
    new_end = old_end + delta

    def repl(m):
        col = m.group(1)
        row = int(m.group(2))
        if row == old_end:
            # SUM 範囲末端（M36 等）→ 新末端（M41）
            return f'{col}{new_end}'
        elif row >= shift_from:
            return f'{col}{row + delta}'
        return m.group(0)

    return re.sub(r'([A-Z]+)(\d+)', repl, formula)


def _update_merge_ref(ref, delta, shift_from):
    """マージセル参照（例 'A38:G38'）をシフト後に更新する。"""
    if ':' not in ref:
        return ref
    start, end = ref.split(':')

    def shift(cell):
        m = re.match(r'^([A-Z]+)(\d+)$', cell)
        if m and int(m.group(2)) >= shift_from:
            return f"{m.group(1)}{int(m.group(2)) + delta}"
        return cell

    return f"{shift(start)}:{shift(end)}"


def expand_detail_rows(sheet_root, extra, i_odd_last_xf=None):
    """
    明細行を extra 行（1〜5）拡張する。items > 20 のとき generate() から呼ばれる。

    処理内容：
    1. 行 37 以降を +extra シフト（r 属性・セル ref・数式参照を更新）
    2. 行 36 を「最終行スタイル」→「内部偶数スタイル」に変換
       （D/E/F セルは下罫線を持つ borderId=60 を除去するため削除）
    3. 新規行 37〜(36+extra) を挿入（内部行スタイル or 最終行スタイル）
    4. マージセルの更新（シフト + 新規追加）

    i_odd_last_xf: styles.xml に追加した「奇数最終行 I列用」xf のインデックス。
                   最終 item が奇数のとき I 列のスタイルをこれに上書きする。
    """
    sd = sheet_root.find(f'{{{NS}}}sheetData')
    new_last = DETAIL_ROW_END + extra   # 例: extra=5 → new_last=41

    # ── Step 1a: 行 37+ をシフト（r 属性・セル ref・数式参照を更新）──────────
    for row_el in list(sd):
        rn = int(row_el.get('r', 0))
        if rn >= SHIFT_FROM_ROW:
            new_rn = rn + extra
            row_el.set('r', str(new_rn))
            for c in row_el:
                old_ref = c.get('r', '')
                m = re.match(r'^([A-Z]+)(\d+)$', old_ref)
                if m:
                    c.set('r', f"{m.group(1)}{new_rn}")
                # 数式参照を更新
                f_el = c.find(f'{{{NS}}}f')
                if f_el is not None and f_el.text:
                    f_el.text = _update_formula_refs(
                        f_el.text, extra, SHIFT_FROM_ROW, DETAIL_ROW_END
                    )

    # ── Step 1b: 行 37 未満にある数式で shifted 範囲を参照するものも更新 ──────
    # 例: D11="L40"（合計金額表示）→ 拡張後は L40 が明細行になるため L45 へ更新が必要
    for row_el in list(sd):
        rn = int(row_el.get('r', 0))
        if rn < SHIFT_FROM_ROW:
            for c in row_el:
                f_el = c.find(f'{{{NS}}}f')
                if f_el is not None and f_el.text:
                    new_text = _update_formula_refs(
                        f_el.text, extra, SHIFT_FROM_ROW, DETAIL_ROW_END
                    )
                    if new_text != f_el.text:
                        f_el.text = new_text

    # ── Step 2: 行 36 を内部スタイルに変換 ──────────────────────────────────
    # D/E/F セル (s=172, borderId=60) は bottom:thin を持つため、
    # 明細途中行として残すと 20件目の下に不要な区切り線が表示される（Issue 2）。
    # 内部行の 34/35 行目にこれらのセルは存在しないので、削除して揃える。
    for row_el in sd:
        if row_el.get('r') == str(DETAIL_ROW_END):
            cells_to_remove = []
            for c in row_el:
                cur_s = c.get('s', '')
                if cur_s in LAST_ROW_TO_INTERIOR:
                    c.set('s', LAST_ROW_TO_INTERIOR[cur_s])
                else:
                    col_m = re.match(r'^([A-Z]+)', c.get('r', ''))
                    if col_m and col_m.group(1) in ('D', 'E', 'F') and cur_s == '172':
                        cells_to_remove.append(c)
            for c in cells_to_remove:
                row_el.remove(c)
            break

    # ── Step 3: 新規行を挿入 ──────────────────────────────────────────────────
    for offset in range(extra):
        new_rn   = SHIFT_FROM_ROW + offset          # 37, 38, 39, 40, 41
        item_no  = MAX_ROWS_BASE + 1 + offset        # 21, 22, 23, 24, 25
        is_last  = (offset == extra - 1)
        is_even  = (item_no % 2 == 0)

        if is_last:
            styles = NEW_ROW_LAST_STYLES.copy()
            # 奇数最終行の I 列は白背景用の新規 xf を使用（Issue 4）
            if not is_even and i_odd_last_xf is not None:
                styles['I'] = str(i_odd_last_xf)
            cols   = list('ABCDEFGHIJKLM')
        elif is_even:
            styles = NEW_ROW_EVEN_STYLES
            cols   = ['A', 'B', 'C', 'G', 'H', 'I', 'J', 'K', 'L', 'M']
        else:
            styles = NEW_ROW_ODD_STYLES
            cols   = ['A', 'B', 'C', 'G', 'H', 'I', 'J', 'K', 'L', 'M']

        row_el = ET.Element(f'{{{NS}}}row',
                            {'r': str(new_rn), 'ht': '18.75', 'customHeight': '1'})
        for col in cols:
            s = styles.get(col, '')
            if s:
                ET.SubElement(row_el, f'{{{NS}}}c', {'r': f'{col}{new_rn}', 's': s})
        sd.append(row_el)

    # 行番号順にソート
    all_rows = sorted(list(sd), key=lambda el: int(el.get('r', 0)))
    for el in list(sd):
        sd.remove(el)
    for el in all_rows:
        sd.append(el)

    # ── Step 4: マージセル更新 ───────────────────────────────────────────────
    mc_el = sheet_root.find(f'{{{NS}}}mergeCells')
    if mc_el is not None:
        for m_el in list(mc_el):
            old_ref = m_el.get('ref', '')
            new_ref = _update_merge_ref(old_ref, extra, SHIFT_FROM_ROW)
            if new_ref != old_ref:
                m_el.set('ref', new_ref)
        # 新規明細行のマージを追加（C:G・J:K・L:M）
        for rn in range(SHIFT_FROM_ROW, new_last + 1):
            for merge_def in [f'C{rn}:G{rn}', f'J{rn}:K{rn}', f'L{rn}:M{rn}']:
                ET.SubElement(mc_el, f'{{{NS}}}mergeCell', {'ref': merge_def})
        mc_el.set('count', str(len(list(mc_el))))

    # ── Step 5: 条件付き書式（CF）sqref を新規行まで拡張 ─────────────────────
    # テンプレート CF sqref: "A28:G36 H17:H36 I28:I36 J17:M36"
    #   formula: MOD(ROW(),2)=0 / dxfId=0（偶数行=青 fill FFD9E2F3）
    # 36（=DETAIL_ROW_END）で終わる各範囲の末端を new_last に更新する。
    for cf_el in sheet_root.findall(f'{{{NS}}}conditionalFormatting'):
        old_sqref = cf_el.get('sqref', '')

        def _extend_range(m, _end=DETAIL_ROW_END, _new=new_last):
            end_row = int(m.group(3))
            if end_row == _end:
                return f'{m.group(1)}:{m.group(2)}{_new}'
            return m.group(0)

        new_sqref = re.sub(r'([A-Z]+\d+):([A-Z]+)(\d+)', _extend_range, old_sqref)
        if new_sqref != old_sqref:
            cf_el.set('sqref', new_sqref)

    return new_last


def should_exclude(filename, sheet_path, sheet_rels_path,
                   drawing_path, drawing_rels_path):
    """
    マスターシート以外のワークシート / 描画 XML を除外する。
    除外すべき場合 True を返す。
    """
    # 他のワークシート
    if re.match(r'xl/worksheets/sheet\d+\.xml$', filename):
        return filename != sheet_path
    # 他のワークシートの _rels
    if re.match(r'xl/worksheets/_rels/sheet\d+\.xml\.rels$', filename):
        return filename != sheet_rels_path
    # 他の描画
    if re.match(r'xl/drawings/drawing\d+\.xml$', filename):
        return drawing_path is None or filename != drawing_path
    # 他の描画の _rels
    if re.match(r'xl/drawings/_rels/drawing\d+\.xml\.rels$', filename):
        return drawing_rels_path is None or filename != drawing_rels_path
    return False

# ─── メイン生成ロジック ───────────────────────────────────────────────────────

def generate(data):
    template_path = data['template_path']
    output_path   = data['output_path']
    rows          = data.get('rows', [])
    month         = data.get('month', '')

    if len(rows) > MAX_ROWS:
        raise ValueError(f'明細が {MAX_ROWS} 行を超えています（{len(rows)} 件）')
    if not os.path.exists(template_path):
        raise FileNotFoundError(f'テンプレートが見つかりません: {template_path}')

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    # ── テンプレートをコピー（元ファイルは変更しない）──────────────────────
    shutil.copy2(template_path, output_path)

    # ── ZIP を読み込んでシート情報と関連アセットを特定 ────────────────────
    with zipfile.ZipFile(output_path, 'r') as z:
        sheet_path, master_rid = find_sheet_info(z, MASTER_SHEET)
        if not sheet_path:
            raise ValueError(f'テンプレートに「{MASTER_SHEET}」シートが見つかりません')

        drawing_path, drawing_rels_path, media_paths = discover_master_assets(z, sheet_path)

        # シートの _rels ファイルパス
        sheet_dir  = sheet_path.rsplit('/', 1)[0]
        sheet_file = sheet_path.rsplit('/', 1)[1]
        sheet_rels_path = f'{sheet_dir}/_rels/{sheet_file}.rels'

        ws_xml_bytes = z.read(sheet_path)
        styles_bytes_orig = z.read('xl/styles.xml')

    # 奇数最終行 I列用 xf のインデックスを事前計算（rewrite_styles_xml が末尾追加するため）
    _styles_tmp = ET.fromstring(styles_bytes_orig)
    _xfs_tmp    = _styles_tmp.find(f'{{{NS}}}cellXfs')
    i_odd_last_xf = len(list(_xfs_tmp)) if _xfs_tmp is not None else None

    # ── XML を解析してセル値を書き込む ────────────────────────────────────
    sheet_root = ET.fromstring(ws_xml_bytes)

    # L2: 請求番号
    inv_num = data.get('invoice_number', '')
    if inv_num and not str(inv_num).upper().startswith('NO'):
        inv_num = f'No.{inv_num}'
    set_inline_string(sheet_root, 'L2', inv_num)

    # L3: 請求日（シリアル値）
    if data.get('invoice_date'):
        set_date(sheet_root, 'L3', data['invoice_date'])

    # D46: 支払期限（シリアル値）
    # テンプレートの =EOMONTH(L3,0) 数式を確定値で上書き。
    # ユーザーが生成画面で変更した場合もこちらの値が優先される。
    if data.get('due_date'):
        set_date(sheet_root, 'D46', data['due_date'])

    # A5: 請求先
    if data.get('client'):
        set_inline_string(sheet_root, 'A5', data['client'])

    # K39: 消費税率
    set_number(sheet_root, 'K39', data.get('tax_rate', 10))

    # C43: 備考
    if data.get('memo'):
        set_inline_string(sheet_root, 'C43', data['memo'])

    # 明細行拡張（21〜25件時のみ：コピー側に5行挿入）
    extra = max(0, len(rows) - MAX_ROWS_BASE)
    effective_detail_end = DETAIL_ROW_END
    if extra > 0:
        effective_detail_end = expand_detail_rows(sheet_root, extra, i_odd_last_xf)

    # 明細行クリア（17〜36）
    for row in range(DETAIL_ROW_START, DETAIL_ROW_END + 1):
        for col in DETAIL_COLS.keys():
            ref = cell_ref(col, row)
            if not is_formula_cell(sheet_root, ref):
                clear_cell(sheet_root, ref)

    # 明細行書き込み
    for idx, item in enumerate(rows):
        row = DETAIL_ROW_START + idx
        for col, field in DETAIL_COLS.items():
            ref = cell_ref(col, row)
            if is_formula_cell(sheet_root, ref):
                continue
            val = item.get(field)
            if val is None:
                continue
            if col in DETAIL_STRING_COLS:
                # 文字列系（B=日付, C=内容, I=単位）
                # H=数量 は表示形式を完全制御するため文字列として書く：
                #   整数 1.0 / 1 → "1"、小数 1.5 → "1.5"
                if col == 'H':
                    num = float(val)
                    str_val = str(int(num)) if num == int(num) else str(num)
                    set_inline_string(sheet_root, ref, str_val)
                else:
                    set_inline_string(sheet_root, ref, val)
            else:
                # 数値系（A=no, J=単価, L=金額）
                num_val = val
                if isinstance(num_val, float) and num_val == int(num_val):
                    num_val = int(num_val)
                set_number(sheet_root, ref, num_val)

    # ── レイアウト調整（列幅・行高）────────────────────────────────────
    fix_sheet_layout(sheet_root, effective_end=effective_detail_end)

    # ── 修正済みシート XML をバイト列に変換 ──────────────────────────────
    new_ws_xml = (b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
                  + ET.tostring(sheet_root, encoding='unicode').encode('utf-8'))

    # ── シート名 ──────────────────────────────────────────────────────────
    new_sheet_name = f'{month.replace("-", "")} 請求書' if month else MASTER_SHEET

    # ── ZIP 再構築（マスターシート 1 枚のみ出力）─────────────────────────
    tmp_path = output_path + '.tmp'
    with zipfile.ZipFile(output_path, 'r') as zin, \
         zipfile.ZipFile(tmp_path, 'w', compression=zipfile.ZIP_DEFLATED) as zout:

        for item in zin.infolist():
            fn = item.filename

            # ── 他シートの XML / rels は除外 ────────────────────────────
            if should_exclude(fn, sheet_path, sheet_rels_path,
                              drawing_path, drawing_rels_path):
                continue

            # ── 書き換えが必要なファイル ─────────────────────────────────
            if fn == sheet_path:
                zout.writestr(item, new_ws_xml)

            elif fn == 'xl/workbook.xml':
                zout.writestr(item, rewrite_workbook_xml(
                    zin.read(fn), master_rid, new_sheet_name))

            elif fn == 'xl/_rels/workbook.xml.rels':
                zout.writestr(item, rewrite_workbook_rels(
                    zin.read(fn), master_rid))

            elif fn == '[Content_Types].xml':
                zout.writestr(item, rewrite_content_types(
                    zin.read(fn), sheet_path, drawing_path))

            elif fn == 'xl/styles.xml':
                # numFmt修正 + shrinkToFit 追加
                zout.writestr(item, rewrite_styles_xml(zin.read(fn)))

            else:
                # その他（sharedStrings, theme, media, drawings, docProps, etc.）
                zout.writestr(item, zin.read(fn))

    os.replace(tmp_path, output_path)
    return {'ok': True, 'output_path': output_path}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', help='JSON 文字列として入力')
    args = parser.parse_args()

    # Windows では sys.stdin がデフォルト CP932 になるため
    # stdin は常にバイト列として読み取り UTF-8 でデコードする
    raw = args.json if args.json else sys.stdin.buffer.read().decode('utf-8')
    try:
        data   = json.loads(raw)
        result = generate(data)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        import traceback
        print(json.dumps({'ok': False, 'error': str(e),
                          'trace': traceback.format_exc()}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
