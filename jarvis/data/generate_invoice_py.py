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

import sys, json, os, shutil, zipfile, re, argparse, datetime
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

MASTER_SHEET = '★請求書マスター'
DETAIL_ROW_START = 17
DETAIL_ROW_END   = 36
MAX_ROWS         = DETAIL_ROW_END - DETAIL_ROW_START + 1

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
    - xf[199] (I39 消費税相当額) alignment に shrinkToFit="1" 追加
      → I39:J39 のマージ幅に「消費税相当額」が収まりきらないため自動縮小

    ※ xf[26] (A5 請求先名) は原本に shrinkToFit なし → 追加しない
    ※ xf[52] (I9 発行者名)  は narrow 列からオーバーフロー表示前提 → 追加しない
       （shrinkToFit を入れると I列=6.86幅に17ptの文字が4pt以下まで縮小される）
    """
    root = ET.fromstring(styles_bytes)

    # xf[199] の alignment に shrinkToFit を追加
    xfs = root.find(f'{{{NS}}}cellXfs')
    if xfs is not None:
        xf_list = list(xfs)
        idx = 199
        if idx < len(xf_list):
            xf = xf_list[idx]
            al = xf.find(f'{{{NS}}}alignment')
            if al is None:
                al = ET.SubElement(xf, f'{{{NS}}}alignment')
            al.set('shrinkToFit', '1')
            xf.set('applyAlignment', '1')

    return (b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            + ET.tostring(root, encoding='unicode').encode('utf-8'))


def fix_sheet_layout(sheet_root):
    """
    シート XML にレイアウト調整を適用する（テンプレートは変更しない）：
    1. J列（col 10）の幅を 8.71 → 10.5 に拡張
       → I39:J39 マージで「消費税相当額」（7文字）が収まるよう調整
    2. 9行目の行高を 18.75 → 24.0 に拡張
       → I9 発行者名（17pt Meiryo）の垂直クリップを防ぐ
    """
    # 1. J列幅を拡張
    cols_el = sheet_root.find(f'{{{NS}}}cols')
    if cols_el is not None:
        to_remove = []
        to_add = []
        for col in list(cols_el):
            mn = int(col.get('min', 0))
            mx = int(col.get('max', 0))
            w  = col.get('width', '')
            # J列 = col 10 が他の列と同じ範囲にまとめられている場合は分割
            if mn <= 10 <= mx and mn != mx:
                to_remove.append(col)
                # J列より前の範囲
                if mn <= 9:
                    pre = ET.Element(f'{{{NS}}}col', {
                        'customWidth': col.get('customWidth', '1'),
                        'min': str(mn), 'max': '9', 'width': w,
                    })
                    to_add.append(pre)
                # J列単体
                j_col = ET.Element(f'{{{NS}}}col', {
                    'customWidth': '1', 'min': '10', 'max': '10', 'width': '10.5',
                })
                to_add.append(j_col)
                # J列より後の範囲
                if mx >= 11:
                    post = ET.Element(f'{{{NS}}}col', {
                        'customWidth': col.get('customWidth', '1'),
                        'min': '11', 'max': str(mx), 'width': w,
                    })
                    to_add.append(post)
            elif mn == 10 and mx == 10:
                # すでに J 単体定義なら幅だけ更新
                col.set('width', '10.5')
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

    # 3. 明細 I 列（単位）のスタイルを統一
    #    テンプレートは行 25 以降で I 列が xf[160]/[164]（Calibri 11pt）に切り替わる。
    #    値書き込み時にこのスタイルを継承すると 1〜8 件目（Meiryo 13pt）と見た目が異なるため
    #    160 → 153（奇数行・Meiryo 13pt・fillなし）
    #    164 → 111（偶数行・Meiryo 13pt・fill あり）に正規化する。
    I_STYLE_MAP = {'160': '153', '164': '111'}
    if sd is not None:
        for row_el in sd:
            rn = int(row_el.get('r', 0))
            if DETAIL_ROW_START <= rn <= DETAIL_ROW_END:
                for c in row_el:
                    ref = c.get('r', '')
                    if ref.startswith('I') and ref[1:] == str(rn):
                        cur_s = c.get('s', '')
                        if cur_s in I_STYLE_MAP:
                            c.set('s', I_STYLE_MAP[cur_s])


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

    # A5: 請求先
    if data.get('client'):
        set_inline_string(sheet_root, 'A5', data['client'])

    # K39: 消費税率
    set_number(sheet_root, 'K39', data.get('tax_rate', 10))

    # C43: 備考
    if data.get('memo'):
        set_inline_string(sheet_root, 'C43', data['memo'])

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
    fix_sheet_layout(sheet_root)

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

    raw = args.json if args.json else sys.stdin.read()
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
