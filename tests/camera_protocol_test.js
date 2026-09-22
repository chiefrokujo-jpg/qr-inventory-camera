'use strict';
/* node tests/camera_protocol_test.js
   index.htmlのscriptを取り出し、vmと最小限のモック（DOM・window・Html5Qrcode）で
   実際の関数を検査する。外部パッケージ・実カメラは使わない。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('inline script not found'); process.exit(2); }
const script = m[1];

let total = 0, failed = 0;
function check(name, cond) {
  total++;
  if (!cond) { failed++; console.log('NG  ' + name); }
}
function eq(name, actual, expected) {
  total++;
  if (actual !== expected) { failed++; console.log('NG  ' + name + '\n    actual  : ' + JSON.stringify(actual) + '\n    expected: ' + JSON.stringify(expected)); }
}

function makeEl() {
  const classes = new Set();
  return {
    textContent: '', className: '', href: '', disabled: false, style: {},
    listeners: {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    addEventListener(t, f) { this.listeners[t] = f; },
    hidden() { return classes.has('hidden'); }
  };
}

/* opts: {search, opener: 'ok'|'none'|'throw'|'focusThrow', startError, startErrors:[…], settings, settingsThrow,
           noSettings, capabilities, capabilitiesThrow, noCapabilities, now, video, innerWidth} */
function load(opts) {
  opts = opts || {};
  const els = {};
  const timers = [];
  const intervals = [];
  const posted = [];
  const replaced = [];
  const scannerCalls = [];
  const bodyClasses = new Set();
  let closed = 0;
  let focused = 0;
  const ctx = {
    console: { warn() {}, log() {}, error() {} }, URLSearchParams, String, Math, Date, Object, Array, encodeURIComponent, Promise,
    performance: { now: () => opts.now === undefined ? 1000 : (typeof opts.now === 'function' ? opts.now() : opts.now) },
    innerWidth: opts.innerWidth || 390,
    location: { search: opts.search || '', replace: u => replaced.push(u) },
    navigator: { vibrate() {} },
    setTimeout: (f, d) => { const id = timers.length + 1; timers.push({ f, d, id, cancelled: false }); return id; },
    clearTimeout: (id) => { timers.forEach(x => { if (x.id === id) x.cancelled = true; }); },
    setInterval: (f, d) => { const id = intervals.length + 1; intervals.push({ f, d, id, cleared: false }); return id; },
    clearInterval: (id) => { intervals.forEach(x => { if (x.id === id) x.cleared = true; }); },
    addEventListener() {},
    document: {
      getElementById: id => els[id] || (els[id] = makeEl()),
      body: { classList: { add: c => bodyClasses.add(c), remove: c => bodyClasses.delete(c), contains: c => bodyClasses.has(c) } },
      querySelector: sel => (sel === '#reader video' ? (opts.video || null) : null)
    },
    Html5QrcodeSupportedFormats: { QR_CODE: 0, EAN_13: 7, EAN_8: 6 },
    Html5Qrcode: function (id, cfg) {
      this.cfg = cfg; scannerCalls.push(this);
      const index = scannerCalls.length - 1;
      this.start = async (cam, conf, ok) => {
        this.startArgs = { cam, conf, ok };
        if (opts.startErrors && opts.startErrors[index] !== undefined) throw opts.startErrors[index];
        if (opts.startError) throw opts.startError;
      };
      this.stop = async () => { this.stopped = (this.stopped || 0) + 1; if (opts.stopThrows) throw new Error('stop failed'); };
      this.clear = async () => {};
      if (!opts.noSettings) this.getRunningTrackSettings = () => { if (opts.settingsThrow) throw new Error('x'); return opts.settings; };
      if (!opts.noCapabilities) this.getRunningTrackCapabilities = () => { if (opts.capabilitiesThrow) throw new Error('x'); return opts.capabilities; };
    }
  };
  ctx.window = ctx;
  ctx.crypto = { randomUUID: () => 'uuid-' + posted.length };
  if (opts.opener === 'ok') ctx.opener = { closed: false, postMessage: (d, o) => posted.push({ d, o }), focus() { focused++; } };
  else if (opts.opener === 'throw') ctx.opener = { closed: false, postMessage() { throw new Error('x'); }, focus() { focused++; } };
  else if (opts.opener === 'focusThrow') ctx.opener = { closed: false, postMessage: (d, o) => posted.push({ d, o }), focus() { focused++; throw new Error('focus'); } };
  else ctx.opener = null;
  ctx.close = () => { closed++; if (opts.closeThrows) throw new Error('close'); };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return {
    ctx, els, timers, intervals, posted, replaced, scannerCalls, bodyClasses,
    closed: () => closed,
    focused: () => focused,
    run: code => vm.runInContext(code, ctx),
    async start() { await ctx.start(); return scannerCalls[scannerCalls.length - 1]; },
    flush() { const t = timers.splice(0).filter(x => !x.cancelled); t.forEach(x => x.f()); },
    /* 指定した遅延のタイマー（取り消されていないもの）だけを実行する */
    fire(d) { const t = timers.filter(x => x.d === d && !x.cancelled); t.forEach(x => { x.cancelled = true; x.f(); }); return t.length; },
    pending(d) { return timers.filter(x => x.d === d && !x.cancelled).length; },
    async settle() { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); }
  };
}

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const fmt = n => ({ result: { format: { formatName: n } } });
const QR = 'ABCDE-12345';

async function main() {
  /* ===== URL・purpose ===== */
  const cfgOf = (search) => JSON.parse(load({ search }).run('JSON.stringify(config)'));
  eq('purpose省略→inventory', cfgOf('').purpose, 'inventory');
  check('purpose省略はok', cfgOf('').ok === true);
  eq('purpose=inventory', cfgOf('?purpose=inventory').purpose, 'inventory');
  eq('product_select', cfgOf('?purpose=product_select&rid=' + UUID).purpose, 'product_select');
  eq('jan_register', cfgOf('?purpose=jan_register&rid=' + UUID).purpose, 'jan_register');
  for (const p of ['foo', '', 'INVENTORY', 'constructor', '__proto__', 'toString', 'jan_register ']) {
    check('不明purpose拒否: ' + JSON.stringify(p), cfgOf('?purpose=' + encodeURIComponent(p) + '&rid=' + UUID).ok === false);
  }
  check('product_selectでrid無しは拒否', cfgOf('?purpose=product_select').ok === false);
  check('jan_registerでrid無しは拒否', cfgOf('?purpose=jan_register').ok === false);
  check('rid空は拒否', cfgOf('?purpose=jan_register&rid=').ok === false);
  eq('UUID形式のridを許可', cfgOf('?purpose=jan_register&rid=' + UUID).requestId, UUID);
  eq('英数_-のrid', cfgOf('?purpose=product_select&rid=abc_DEF-1234').requestId, 'abc_DEF-1234');
  for (const r of ['short', 'abcdefg', 'a'.repeat(129), 'abcd efgh1234', 'abcd.efgh1234', 'abcd/efgh1234', '<script>alert(1)', 'あいうえおかきくけこ']) {
    check('不正rid拒否: ' + r.slice(0, 20), cfgOf('?purpose=jan_register&rid=' + encodeURIComponent(r)).ok === false);
  }
  check('rid 8文字は許可', cfgOf('?purpose=jan_register&rid=' + 'a'.repeat(8)).ok === true);
  check('rid 128文字は許可', cfgOf('?purpose=jan_register&rid=' + 'a'.repeat(128)).ok === true);
  eq('inventoryでridなしはrequestId空', cfgOf('?purpose=inventory').requestId, '');
  eq('inventoryで正常ridはそのまま', cfgOf('?rid=' + UUID).requestId, UUID);
  check('inventoryで不正ridは開始を妨げない', cfgOf('?rid=<x>').ok === true);
  eq('inventoryで不正ridはrequestId空', cfgOf('?rid=<x>').requestId, '');

  /* 不明purpose・不正ridではカメラを開始しない */
  {
    const t = load({ search: '?purpose=zzz&autostart=1' });
    t.flush();
    eq('不明purpose: Html5Qrcode未生成(autostart)', t.scannerCalls.length, 0);
    check('不明purpose: 日本語エラー表示', /利用方法が正しくありません/.test(t.els.status.textContent));
    check('不明purpose: 起動ボタン非表示', t.els.startButton.hidden());
    await t.ctx.start();
    eq('不明purpose: start()直接呼びでも未生成', t.scannerCalls.length, 0);
    const t2 = load({ search: '?purpose=jan_register&autostart=1' });
    t2.flush(); await t2.ctx.start();
    eq('rid無し: カメラ未開始', t2.scannerCalls.length, 0);
    check('rid無し: 日本語エラー', /利用方法が正しくありません/.test(t2.els.status.textContent));
  }

  /* ===== format / formatsToSupport ===== */
  {
    const t = load({ search: '' });
    const sc = await t.start();
    eq('inventory: formatsToSupport=QRのみ(件数)', sc.cfg.formatsToSupport.length, 1);
    eq('inventory: formatsToSupport=QR', sc.cfg.formatsToSupport[0], 0);
    const t2 = load({ search: '?purpose=product_select&rid=' + UUID });
    const sc2 = await t2.start();
    eq('product_select: QRのみ', JSON.stringify(sc2.cfg.formatsToSupport), '[0]');
    const t3 = load({ search: '?purpose=jan_register&rid=' + UUID });
    const sc3 = await t3.start();
    eq('jan_register: EAN_13/EAN_8', JSON.stringify(sc3.cfg.formatsToSupport), '[7,6]');
  }

  async function scan(search, opener, decoded, result) {
    const t = load({ search, opener });
    await t.start();
    await t.ctx.success(decoded, result);
    return t;
  }

  /* format判定 */
  {
    let t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '4901234567894', fmt('EAN_13'));
    eq('jan: EAN_13受理', t.posted.length, 1);
    t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '49123456', fmt('EAN_8'));
    eq('jan: EAN_8受理', t.posted.length, 1);
    t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '4901234567894', fmt('QR_CODE'));
    eq('jan: QR_CODE拒否', t.posted.length, 0);
    check('jan: QR拒否メッセージ', /QRコード/.test(t.els.status.textContent) && t.els.status.className.includes('bad'));
    t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '4901234567894', {});
    eq('jan: format無し拒否', t.posted.length, 0);
    t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '4901234567894', undefined);
    eq('jan: result自体無し拒否', t.posted.length, 0);
    t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '4901234567894', fmt('CODE_128'));
    eq('jan: その他format拒否', t.posted.length, 0);
    t = await scan('?purpose=product_select&rid=' + UUID, 'ok', QR, fmt('QR_CODE'));
    eq('product_select: QR受理', t.posted.length, 1);
    t = await scan('?purpose=product_select&rid=' + UUID, 'ok', '4901234567894', fmt('EAN_13'));
    eq('product_select: EAN拒否', t.posted.length, 0);
    check('product_select: EAN拒否メッセージ', /JANバーコード/.test(t.els.status.textContent));
    t = await scan('?purpose=product_select&rid=' + UUID, 'ok', QR, fmt('CODE_128'));
    eq('product_select: その他format拒否', t.posted.length, 0);
    t = await scan('', 'ok', QR, fmt('QR_CODE'));
    eq('inventory: QR受理', t.posted.length, 1);
    t = await scan('', 'ok', QR, fmt('EAN_13'));
    eq('inventory: EAN拒否', t.posted.length, 0);
    t = await scan('', 'ok', QR);
    eq('inventory: format省略(従来呼び出し)は受理', t.posted.length, 1);
    eq('inventory: format省略時はQR_CODE', t.posted[0].d.format, 'QR_CODE');
    /* 拒否形式では読み取り継続（停止・完了しない） */
    t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '4901234567894', fmt('QR_CODE'));
    eq('不許可形式: カメラ停止しない', t.scannerCalls[0].stopped || 0, 0);
    check('不許可形式: completedにならない', t.run('completed') === false);
    await t.ctx.success('4901234567894', fmt('EAN_13'));
    eq('不許可形式の後に正しい形式を受理', t.posted.length, 1);
  }

  /* ===== 値 ===== */
  {
    const v = s => load({}).run('validQr(' + JSON.stringify(s) + ')');
    check('validQr正常', v('ABCDE') && v('A1234') && v('AB-12345') && v('A' + '1'.repeat(79)));
    check('validQr異常', !v('') && !v('ABCD') && !v('-ABCDE') && !v('abcde') && !v('AB CDE') && !v('A' + '1'.repeat(80)) && !v('AB_CDE'));
    let t = await scan('', 'ok', '  abcde-12345 ', fmt('QR_CODE'));
    eq('QR値は大文字化・trim', t.posted[0].d.qr, 'ABCDE-12345');
    t = await scan('', 'ok', 'abc', fmt('QR_CODE'));
    eq('inventory: 短いQR拒否', t.posted.length, 0);
    check('inventory: 従来文言(読み取り値付き)', t.els.status.textContent === '棚卸用QRの形式ではありません。\n読み取り値：ABC');
    t = await scan('?purpose=product_select&rid=' + UUID, 'ok', 'abc', fmt('QR_CODE'));
    eq('product_select: validQr不正拒否', t.posted.length, 0);
    t = await scan('?purpose=product_select&rid=' + UUID, 'ok', 'abcde-1', fmt('QR_CODE'));
    eq('product_select: 大文字化', t.posted[0].d.qr, 'ABCDE-1');

    const J = '?purpose=jan_register&rid=' + UUID;
    t = await scan(J, 'ok', ' 4901234567894 ', fmt('EAN_13'));
    eq('JAN: trimして数字のみ', t.posted[0].d.qr, '4901234567894');
    t = await scan(J, 'ok', '0012345678905', fmt('EAN_13'));
    eq('JAN: 先頭0を保持', t.posted[0].d.qr, '0012345678905');
    t = await scan(J, 'ok', '00000009', fmt('EAN_8'));
    eq('JAN: EAN_8先頭0を保持', t.posted[0].d.qr, '00000009');
    for (const bad of ['49012345678A4', '4901 234567894', '4901-234567894', '4901234567894!', 'abc', '', '４９０１２３４５６７８９４', '+4901234567894', '4901234567.94', '1e10']) {
      t = await scan(J, 'ok', bad, fmt('EAN_13'));
      eq('JAN不正値拒否: ' + JSON.stringify(bad), t.posted.length, 0);
      check('JAN不正値: 数字へ変換して結果表示しない: ' + JSON.stringify(bad), t.els.result.textContent === '' && t.run('completed') === false);
    }
    t = await scan(J, 'ok', 'ABC4901234567894', fmt('EAN_13'));
    eq('英字混在を数字だけへ変換しない', t.posted.length, 0);
    t = await scan(J, 'ok', '4901234567894', fmt('EAN_13'));
    eq('JAN: 桁数・チェックデジット判定は追加していない(短い数字も受理)', (await scan(J, 'ok', '12345', fmt('EAN_13'))).posted.length, 1);
  }

  /* ===== postMessage ===== */
  {
    let t = await scan('', 'ok', QR, fmt('QR_CODE'));
    let p = t.posted[0];
    eq('inventory: source', p.d.source, 'qr-inventory-camera');
    eq('inventory: qr', p.d.qr, QR);
    check('inventory: id有り', typeof p.d.id === 'string' && p.d.id.length > 0);
    eq('inventory: format', p.d.format, 'QR_CODE');
    eq('inventory: purpose', p.d.purpose, 'inventory');
    eq('inventory: requestId未指定は空文字', p.d.requestId, '');
    eq('targetOrigin', p.o, '*');
    eq('inventory: キー構成', Object.keys(p.d).sort().join(','), 'format,id,purpose,qr,requestId,source');
    t = await scan('?rid=' + UUID, 'ok', QR, fmt('QR_CODE'));
    eq('inventory: rid指定時はそのまま返す', t.posted[0].d.requestId, UUID);
    t = await scan('?purpose=product_select&rid=' + UUID, 'ok', QR, fmt('QR_CODE'));
    p = t.posted[0];
    eq('product_select: purpose', p.d.purpose, 'product_select');
    eq('product_select: requestId', p.d.requestId, UUID);
    eq('product_select: format', p.d.format, 'QR_CODE');
    eq('product_select: source', p.d.source, 'qr-inventory-camera');
    t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '4901234567894', fmt('EAN_13'));
    p = t.posted[0];
    eq('jan: format', p.d.format, 'EAN_13');
    eq('jan: purpose', p.d.purpose, 'jan_register');
    eq('jan: requestId(UUIDそのまま)', p.d.requestId, UUID);
    eq('jan: targetOrigin', p.o, '*');
    eq('jan: キー構成', Object.keys(p.d).sort().join(','), 'format,id,purpose,qr,requestId,source');
    eq('jan: EAN_8のformat', (await scan('?purpose=jan_register&rid=' + UUID, 'ok', '49123456', fmt('EAN_8'))).posted[0].d.format, 'EAN_8');
    /* sessionToken等はURLに付いても返さない */
    t = await scan('?purpose=jan_register&rid=' + UUID + '&sessionToken=SECRET123&productId=P1&name=abc', 'ok', '4901234567894', fmt('EAN_13'));
    check('sessionToken・商品情報を含まない', !/SECRET123|P1|abc|sessionToken|productId/.test(JSON.stringify(t.posted[0].d)));
    /* 多重送信防止 */
    t = load({ search: '?purpose=jan_register&rid=' + UUID, opener: 'ok' });
    await t.start();
    await Promise.all([t.ctx.success('4901234567894', fmt('EAN_13')), t.ctx.success('4901234567894', fmt('EAN_13'))]);
    await t.ctx.success('4901234567894', fmt('EAN_13'));
    eq('completedで多重送信しない', t.posted.length, 1);
    eq('completed後にカメラ停止', t.scannerCalls[0].stopped, 1);
    t = load({ search: '', opener: 'ok' });
    await t.start();
    await t.ctx.success(QR, fmt('QR_CODE')); await t.ctx.success(QR, fmt('QR_CODE'));
    eq('inventory: 多重送信しない', t.posted.length, 1);
    /* openerあり: 短時間後にclose */
    t = await scan('?purpose=jan_register&rid=' + UUID, 'ok', '4901234567894', fmt('EAN_13'));
    t.flush();
    eq('jan: opener有りでclose試行', t.closed(), 1);
    eq('jan: opener有りでlocation.replaceしない', t.replaced.length, 0);
    check('jan: 閉じられない場合の案内', /閉じない場合/.test(t.els.status.textContent));
    t = await scan('', 'ok', QR, fmt('QR_CODE'));
    t.flush();
    eq('inventory: opener有りでclose', t.closed(), 1);
    eq('inventory: opener有りでlocation.replaceしない', t.replaced.length, 0);
  }
  {
    const t = await scan('', 'ok', QR, fmt('QR_CODE'));
    check('inventory: setTimeout(close,400)', t.timers.some(x => x.d === 400));
  }

  /* ===== フォールバック ===== */
  {
    const APP = 'https://example.invalid/app?x=1';
    let t = await scan('?app=' + encodeURIComponent(APP), 'none', QR, fmt('QR_CODE'));
    t.flush();
    eq('inventory: opener無しでlocation.replace', t.replaced.length, 1);
    eq('inventory: URLにqrとcamera=1(appに?有り)', t.replaced[0], APP + '&qr=' + QR + '&camera=1');
    eq('inventory: 戻るリンクhref', t.els.returnButton.href, APP + '&qr=' + QR + '&camera=1');
    check('inventory: 戻るリンク表示', !t.els.returnButton.hidden());
    t = await scan('?app=' + encodeURIComponent('https://example.invalid/app'), 'none', QR, fmt('QR_CODE'));
    t.flush();
    eq('inventory: appに?無し', t.replaced[0], 'https://example.invalid/app?qr=' + QR + '&camera=1');
    t = await scan('?app=' + encodeURIComponent(APP), 'throw', QR, fmt('QR_CODE'));
    t.flush();
    eq('inventory: postMessage失敗でもフォールバック', t.replaced.length, 1);
    t = await scan('', 'none', QR, fmt('QR_CODE'));
    t.flush();
    eq('inventory: app無しは遷移しない', t.replaced.length, 0);

    for (const [purpose, val, f] of [['product_select', QR, 'QR_CODE'], ['jan_register', '4901234567894', 'EAN_13']]) {
      for (const op of ['none', 'throw']) {
        t = await scan('?purpose=' + purpose + '&rid=' + UUID + '&app=' + encodeURIComponent(APP), op, val, fmt(f));
        t.flush();
        const tag = purpose + '/' + op;
        eq(tag + ': 自動location.replaceしない', t.replaced.length, 0);
        eq(tag + ': 案内文', t.els.status.textContent, '元の画面へ結果を返せませんでした。元の棚卸画面のタブへ戻り、もう一度読み取るか手入力してください。');
        check(tag + ': 結果リンクを表示しない', t.els.returnButton.hidden() && t.els.returnButton.href === '');
        check(tag + ': 戻るボタンにapp・値・rid・purposeを含まない（href未設定）', t.els.backButton.href === '');
        eq(tag + ': closeしない', t.closed(), 0);
      }
    }
    /* 管理者用途の戻るボタンは、app URLへ移動しない（下の「戻るボタン（管理者用途）」で詳細を検査） */
    t = load({ search: '?purpose=jan_register&rid=' + UUID + '&app=' + encodeURIComponent(APP) });
    check('jan: 戻るボタンにapp URLを設定しない（リンク遷移させない）', t.els.backButton.href === '' && !t.els.backButton.hidden());
    await t.start();
    await t.ctx.success('4901234567894', fmt('EAN_13'));
    await t.els.backButton.listeners.click({ preventDefault() {} });
    await t.settle();
    eq('jan: 完了後（結果を返せなかった場合）の戻るでもlocation.replaceしない', t.replaced.length, 0);
    t = load({ search: '?app=' + encodeURIComponent(APP), opener: 'ok' });
    await t.start();
    await t.ctx.success(QR, fmt('QR_CODE'));
    await t.els.backButton.listeners.click({ preventDefault() {} });
    eq('inventory: 完了後の戻るクリックは従来どおり何もしない', t.replaced.length, 0);
    t = load({ search: '?app=' + encodeURIComponent(APP) });
    await t.start();
    await t.els.backButton.listeners.click({ preventDefault() {} });
    eq('inventory: 読取前の戻る=stopして遷移', t.replaced[0], APP);
    eq('inventory: 戻る時にカメラ停止', t.scannerCalls[0].stopped, 1);
  }

  /* ===== JAN読取設定（jan_registerだけ）とQR設定の維持 ===== */
  {
    const J = '?purpose=jan_register&rid=' + UUID;
    const PS = '?purpose=product_select&rid=' + UUID;
    let t = load({ search: J });
    let sc = await t.start();
    const c = sc.startArgs.conf;
    const vc = c.videoConstraints;
    check('JAN: html5-qrcodeへ渡す形式はEAN_13／EAN_8だけ', JSON.stringify(sc.cfg.formatsToSupport) === '[7,6]');
    check('JAN: 背面カメラ（videoConstraints.facingMode=environment。ライブラリはvideoConstraints有効時に第1引数を使わないため）', vc && vc.facingMode === 'environment' && sc.startArgs.cam.facingMode === 'environment');
    check('JAN: 高解像度をideal指定（幅1920・高さ1080）', vc && vc.width && vc.width.ideal === 1920 && vc.height && vc.height.ideal === 1080);
    check('JAN: exact指定を使わない（端末が対応できなくてもフォールバックできる）', JSON.stringify(vc).indexOf('exact') < 0 && JSON.stringify(vc).indexOf('min') < 0);
    check('JAN: aspectRatio: 1を適用しない（映像を正方形へ強制しない）', c.aspectRatio === undefined && !('aspectRatio' in vc));
    check('JAN: disableFlipを有効にする', c.disableFlip === true);
    check('JAN: fpsは現実的な範囲（10〜20）', c.fps >= 10 && c.fps <= 20 && c.fps === 15);
    check('JAN: qrboxは関数（ライブラリが渡すviewfinderWidth／Heightを基準にする）', typeof c.qrbox === 'function');
    check('JAN: videoConstraintsにライブラリが拒否する音声系キーが無い（無視されない）', ['autoGainControl', 'channelCount', 'echoCancellation', 'latency', 'noiseSuppression', 'sampleRate', 'sampleSize', 'volume'].every(k => !(k in vc)));
    check('JAN: 未対応の推測オプション（torch・advanced・focusMode等）を追加していない', Object.keys(c).sort().join(',') === 'disableFlip,fps,qrbox,videoConstraints' && Object.keys(vc).sort().join(',') === 'facingMode,height,width');
    check('JAN: UPC_Aを許可していない', JSON.stringify(sc.cfg.formatsToSupport).indexOf('UPC') < 0 && !/UPC_A/.test(script));

    /* qrbox関数：viewfinderWidth／viewfinderHeightから計算する */
    for (const W of [320, 375, 390, 414, 430]) {
      const V = W - 34;
      const H = Math.floor(V * 16 / 9);
      const q = c.qrbox(V, H);
      check('qrbox(' + V + '×' + H + '): 横長・正の整数・表示領域内・50px以上', q.width > q.height && Number.isInteger(q.width) && Number.isInteger(q.height) && q.width <= V && q.height <= H && q.width >= 50 && q.height >= 50);
    }
    const q1 = c.qrbox(356, 633), q2 = c.qrbox(300, 633);
    check('qrbox：viewfinderWidthに比例する（window.innerWidthに依存しない）', q1.width !== q2.width && Math.abs(q1.width / 356 - q2.width / 300) < .01);
    check('qrbox：viewfinderHeightが小さければ高さを収める', c.qrbox(356, 120).height <= 120 && c.qrbox(356, 120).width <= 356);
    check('qrbox：異常な入力（0・負数・NaN・undefined）でも例外にならず0以下を返さない', [[0, 0], [-5, -5], [NaN, NaN], [undefined, undefined], [1, 1]].every(function (a) { const q = c.qrbox(a[0], a[1]); return q.width >= 1 && q.height >= 1; }));
    t.ctx.innerWidth = 10;
    const q3 = c.qrbox(356, 633);
    check('qrbox：window.innerWidthを変えても結果が変わらない', q3.width === q1.width && q3.height === q1.height);
    check('qrbox関数のソースはinnerWidthを参照しない', !/innerWidth/.test((script.match(/function janQrbox\([\s\S]*?\n  \}/) || [''])[0]));

    /* QR（inventory・product_select）の設定はHEAD 37e4efbのまま */
    for (const search of ['', PS]) {
      const tq = load({ search });
      const sq = await tq.start();
      const cq = sq.startArgs.conf;
      const tag = search ? 'product_select' : 'inventory';
      check(tag + ': fps=10・aspectRatio=1・qrboxは正方形（従来どおり）', cq.fps === 10 && cq.aspectRatio === 1 && typeof cq.qrbox === 'object' && cq.qrbox.width === cq.qrbox.height && cq.qrbox.width === Math.min(Math.max(Math.floor(390 * .68), 220), 330));
      check(tag + ': videoConstraints・disableFlipを追加していない・カメラ指定は従来どおり', !('videoConstraints' in cq) && !('disableFlip' in cq) && Object.keys(cq).sort().join(',') === 'aspectRatio,fps,qrbox' && JSON.stringify(sq.startArgs.cam) === '{"facingMode":"environment"}');
      check(tag + ': QR_CODEだけ', JSON.stringify(sq.cfg.formatsToSupport) === '[0]');
      check(tag + ': 補助案内のタイマーを作らない', tq.pending(9000) === 0 && tq.timers.length === 0);
      check(tag + ': body.janを付けない', !tq.bodyClasses.has('jan'));
    }
    check('JAN: body.jan を付ける', t.bodyClasses.has('jan'));
    /* QR設定の実装行がHEAD(37e4efb)と同一 */
    const qrLines = ["const size=Math.min(Math.max(Math.floor(innerWidth*.68),220),330);", "await scanner.start({facingMode:'environment'},{fps:10,qrbox:qrbox,aspectRatio:1},success,function(){});", "scanner=new Html5Qrcode('reader',{formatsToSupport:purposeDef.formats.map(function(name){return Html5QrcodeSupportedFormats[name]})});"];
    check('QR用の設定行が現在のindex.htmlに従来どおり存在する', qrLines.every(l => script.indexOf(l) >= 0));
    try {
      const head = require('child_process').execFileSync('git', ['show', '37e4efb:index.html'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r\n/g, '\n');
      check('QR用の設定行が37e4efbのindex.htmlにも同一のまま存在する（QR設定の変更なし）', qrLines.every(l => head.indexOf(l) >= 0 && script.replace(/\r\n/g, '\n').indexOf(l) >= 0));
    } catch (e) { console.log('（注意）git showが使えないため37e4efbとの比較は未実施'); }

    /* 解像度の要求が原因の起動失敗だけ、解像度指定を外して1回やり直す */
    const rf = load({ search: J, startErrors: ['Error getting userMedia, error = OverconstrainedError: constraint'] });
    await rf.ctx.start();
    check('解像度が原因（OverconstrainedError文字列）で失敗したら、解像度指定なしで1回だけやり直して起動する', rf.scannerCalls.length === 2 && !('videoConstraints' in rf.scannerCalls[1].startArgs.conf) && rf.scannerCalls[1].startArgs.conf.aspectRatio === undefined && rf.scannerCalls[1].startArgs.conf.disableFlip === true && rf.run('running') === true);
    const rf2 = load({ search: J, startErrors: [{ name: 'OverconstrainedError', message: 'x' }] });
    await rf2.ctx.start();
    check('OverconstrainedError（オブジェクト）でも同様にやり直す', rf2.scannerCalls.length === 2 && rf2.run('running') === true);
    const rf3 = load({ search: J, startErrors: [{ name: 'NotAllowedError' }] });
    await rf3.ctx.start();
    check('権限拒否などは、やり直さず従来の日本語表示（再試行で権限を再要求しない）', rf3.scannerCalls.length === 1 && rf3.els.status.textContent === 'カメラが許可されていません。ブラウザのサイト設定で許可してください。');
    const rf4 = load({ search: J, startErrors: [{ name: 'OverconstrainedError' }, { name: 'NotFoundError' }] });
    await rf4.ctx.start();
    check('やり直しも失敗した場合は、その日本語エラーを表示して再試行を重ねない（2回まで）', rf4.scannerCalls.length === 2 && rf4.els.status.textContent === '利用できるカメラが見つかりません。' && rf4.run('running') === false);
  }

  /* ===== 補助案内（jan_registerだけ・一定時間デコード成功がない場合） ===== */
  {
    const J = '?purpose=jan_register&rid=' + UUID;
    let t = load({ search: J });
    await t.start();
    check('補助案内: 開始直後は表示しない・初期は折りたたみ・9秒のタイマーが1つ', t.els.help.hidden() && t.els.helpDetails.open !== true && t.pending(9000) === 1 && t.timers.every(x => x.d === 9000 || x.d === 350));
    const readingText = t.els.status.textContent;
    t.fire(9000);
    const guide = t.els.helpSummary.textContent + '\n' + t.els.helpText.textContent;
    check('補助案内: 指定時間後にコンパクトな折りたたみ状態で表示する', !t.els.help.hidden() && t.els.helpDetails.open === false && t.els.helpSummary.textContent.length > 0);
    t.els.helpDetails.open = true;
    check('補助案内: 展開すると既存ガイド全文を確認できる', guide === t.run('JAN_HELP_TEXT'));
    check('補助案内: バーコード全体・左右の余白', /バーコード全体/.test(guide) && /左右の余白/.test(guide));
    check('補助案内: 近すぎる場合は少し離す', /近すぎる/.test(guide) && /離/.test(guide));
    check('補助案内: 水平に合わせる', /水平/.test(guide));
    check('補助案内: 明るい場所', /明るい場所/.test(guide));
    check('補助案内: 読み取れない場合は元の画面で手入力できる', /元の画面/.test(guide) && /手入力/.test(guide));
    const guideRoi = t.run('JSON.stringify(lastQrbox)');
    const guideVideo = JSON.stringify(t.ctx.document.querySelector('#reader video'));
    t.els.helpDetails.open = false;
    check('補助案内: 開閉してもJAN処理・映像・ROIへ影響しない', t.run('running') === true && guideRoi === t.run('JSON.stringify(lastQrbox)') && guideVideo === JSON.stringify(t.ctx.document.querySelector('#reader video')));
    check('補助案内: スキャナーを停止しない・読取を継続する', t.scannerCalls[0].stopped === undefined && t.run('running') === true && t.run('completed') === false);
    check('補助案内: 赤いエラー表示（status.bad）を使わない・読取中の表示を変えない', t.els.status.textContent === readingText && t.els.status.className.indexOf('bad') < 0 && t.els.help.className.indexOf('bad') < 0);
    check('補助案内: 案内用の別の見た目（.help）で、エラー用（.status.bad）と区別している', /\.help\{[^}]*background:#fff8e1/.test(html) && /\.status\.bad\{/.test(html) && !/id="help"[^>]*class="[^"]*bad/.test(html));
    check('補助案内: 読取処理は続くので、その後も結果を受理できる', (await (async () => { await t.ctx.success('4901234567894', fmt('EAN_13')); return t.run('completed'); })()) === true);
    check('補助案内: 読取成功で案内を隠す', t.els.help.hidden());

    /* 一度だけ */
    t = load({ search: J });
    await t.start();
    const timer = t.timers.find(x => x.d === 9000);
    timer.cancelled = false;
    timer.f(); t.els.helpText.textContent = 'x';
    timer.f();
    check('補助案内: 一度だけ表示する（同じタイマーが再実行されても再表示しない）', t.els.helpText.textContent === 'x');

    /* 成功・停止・再開でタイマー解除 */
    t = load({ search: J });
    await t.start();
    await t.ctx.success('4901234567894', fmt('EAN_13'));
    check('補助案内: 成功時にタイマーを解除する', t.pending(9000) === 0);
    t.fire(9000);
    check('補助案内: 解除後は表示されない', t.els.help.hidden());
    t = load({ search: J });
    await t.start();
    await t.els.stopButton.listeners.click();
    check('補助案内: 停止時にタイマーを解除する', t.pending(9000) === 0);
    t = load({ search: J });
    await t.start();
    const oldTimer = t.timers.find(x => x.d === 9000);
    const oldF = oldTimer.f;
    await t.els.stopButton.listeners.click();
    await t.start();
    check('補助案内: 再開すると新しいタイマー1つだけ（古いタイマーは取り消し済み）', t.pending(9000) === 1 && oldTimer.cancelled === true);
    oldF();
    check('補助案内: 古いタイマーが次の読取へ影響しない（表示されない）', t.els.help.hidden());
    t.fire(9000);
    check('補助案内: 新しいタイマーは通常どおり表示する', !t.els.help.hidden());
    await t.els.stopButton.listeners.click(); await t.start();
    check('補助案内: 再開時は案内を一度隠す（新しい読取でもう一度表示できる）', t.els.help.hidden() && t.pending(9000) === 1);
    check('補助案内: readerの後に置かれ、映像を押し下げない', html.indexOf('id="reader"') < html.indexOf('id="help"'));
    check('補助案内: 画面終了（pagehide）でタイマーを解除する（ソース）', /addEventListener\('pagehide',function\(\)\{disarmHelp\(\);stopDiagTimer\(\);/.test(script));
    t = load({ search: J, startError: 'x' });
    await t.ctx.start();
    check('補助案内: 起動に失敗した場合はタイマーを作らない', t.pending(9000) === 0);

    /* inventory／product_selectには追加しない */
    for (const search of ['', '?purpose=product_select&rid=' + UUID]) {
      const tq = load({ search });
      await tq.start(); tq.fire(9000);
      check((search ? 'product_select' : 'inventory') + ': 補助案内を表示しない', tq.els.help.hidden() && tq.pending(9000) === 0);
    }
  }

  /* ===== 診断表示（jan_registerだけ・利用者が押した時だけ） ===== */
  {
    const RID2 = 'diagrid-0123456789';
    const APP2 = 'https://app.example.invalid/exec-secret';
    const J = '?purpose=jan_register&rid=' + RID2 + '&app=' + encodeURIComponent(APP2);
    check('診断: HTMLの初期状態は折りたたみ・JAN以外では操作欄を隠す', /id="diag"[^>]*class="diag hidden"/.test(html) && /id="diagButton"[^>]*hidden/.test(html) && /id="help"[^>]*class="help hidden"/.test(html));
    let now = 1000;
    let t = load({ search: J, now: () => now, settings: { width: 1080, height: 1920, frameRate: 30, facingMode: 'environment', zoom: 2, focusMode: 'continuous', focusDistance: 0.4, exposureMode: 'continuous', exposureCompensation: 0, torch: false, deviceId: 'DEVICE-SECRET' }, capabilities: { width: { min: 640, max: 1920 }, height: { min: 480, max: 1080 }, frameRate: { min: 15, max: 30 }, facingMode: ['environment'], zoom: { min: 1, max: 4, step: 0.1 }, focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 1 }, exposureMode: ['continuous'], exposureCompensation: { min: -2, max: 2, step: 0.5 }, torch: true }, video: { videoWidth: 1080, videoHeight: 1920 } });
    const sc = await t.start();
    check('診断: カメラ起動後も、押すまで内容は空（表示しない）', t.els.diag.textContent === '' && t.els.diag.hidden() && t.intervals.length === 0);
    sc.startArgs.conf.qrbox(356, 633);
    await t.els.diagButton.listeners.click();
    const d = t.els.diag.textContent;
    check('診断: 押すと表示する（非表示を解除・ページ再読込なし・カメラを止めない）', !t.els.diag.hidden() && sc.stopped === undefined && t.run('running') === true && t.replaced.length === 0);
    check('診断: 実解像度（設定値と映像フレーム）', /1080×1920/.test(d) && d.split('1080×1920').length === 3);
    check('診断: frameRate', /30 fps/.test(d));
    check('診断: facingMode', /カメラの向き：environment/.test(d));
    check('診断: JAN用qrboxの計算結果', /読取枠：338×169（表示領域 356×633）/.test(d));
    check('診断: purposeとライブラリ表記', /用途：jan_register/.test(d) && /html5-qrcode 2\.3\.8/.test(d));
    check('診断: 公開APIの設定値とcapabilitiesを表示', /ズーム（設定値）：2／対応範囲：1〜4（step 0.1）/.test(d) && /フォーカスモード（設定値）：continuous／対応範囲：continuous, manual/.test(d) && /露出補正（設定値）：0／対応範囲：-2〜2（step 0.5）/.test(d) && /トーチ（設定値）：false／対応範囲：true/.test(d));
    check('診断: 成功前の時間・形式は未取得', /成功まで：未計測/.test(d) && /成功形式：未取得/.test(d));
    check('診断: rid・app URL・deviceId等の秘密情報を表示しない', d.indexOf(RID2) < 0 && d.indexOf('exec-secret') < 0 && d.indexOf('app.example') < 0 && d.indexOf('DEVICE-SECRET') < 0 && !/token|sessionToken|scriptId|deploymentId|productId/i.test(d));
    /* 読取途中（許可されない形式・不正な値で読取が続いている間）に得た値も、診断へ出さない */
    {
      const seen = ['4901234567894', '49-0123456', 'ZZZ-JANLEAK-123'];
      for (const v of seen) await t.ctx.success(v, fmt('QR_CODE'));
      await t.ctx.success('12ab', fmt('EAN_13'));
      t.intervals[0].f();
      const d2 = t.els.diag.textContent;
      check('診断: 読取途中に得たJAN値・読取値を表示しない（読取は継続中）', t.run('running') === true && t.run('completed') === false && seen.every(v => d2.indexOf(v) < 0) && d2.indexOf('12ab') < 0 && /読取枠/.test(d2));
    }
    const roiBefore = t.run('JSON.stringify(lastQrbox)');
    const videoBefore = JSON.stringify(t.ctx.document.querySelector('#reader video'));
    check('診断: 表示は1秒ごとに更新するタイマー1つ', t.intervals.length === 1 && t.intervals[0].d === 1000 && !t.intervals[0].cleared);
    t.els.diagButton.listeners.click();
    check('診断: もう一度押すと隠し、更新タイマーを解除する', t.els.diag.hidden() === true && t.intervals[0].cleared === true && t.els.diagButton.textContent === '診断情報を表示');
    check('診断: 開閉で映像・ROIの寸法を変更しない', roiBefore === t.run('JSON.stringify(lastQrbox)') && videoBefore === JSON.stringify(t.ctx.document.querySelector('#reader video')));
    t.els.diagButton.listeners.click();
    await t.els.stopButton.listeners.click();
    check('診断: カメラ停止時に更新タイマーを解除する', t.intervals.every(x => x.cleared));

    /* 取得不能・例外でも止まらない */
    for (const [tag, o] of [['getRunningTrackSettingsが例外', { settingsThrow: true }], ['settingsがundefined', {}], ['getRunningTrackSettingsが無い', { noSettings: true }], ['getRunningTrackCapabilitiesが例外', { capabilitiesThrow: true }], ['getRunningTrackCapabilitiesが無い', { noCapabilities: true }], ['値が不正', { settings: { width: 'x', height: null, frameRate: NaN, facingMode: '<script>' } }]]) {
      const tn = load(Object.assign({ search: J }, o));
      await tn.start();
      let threw = false;
      try { await tn.els.diagButton.listeners.click(); } catch (e) { threw = true; }
      const dn = tn.els.diag.textContent;
      check('診断（' + tag + '）: 例外にならず「取得できません」と表示・カメラ処理は継続', !threw && /取得できません/.test(dn) && tn.run('running') === true && dn.indexOf('<script>') < 0);
    }
    now = 3500;
    t = load({ search: J, now: () => now, settings: { width: 1080, height: 1920 }, capabilities: {} });
    await t.start();
    check('診断: 初期状態では直前成功結果を持たず、JAN開始時刻を起動完了時に初期化する', t.run('lastJanDiagnostics') === '' && t.run('janStartedAt') === 3500 && t.run('janSuccessElapsedMs') === null && t.run('janSuccessFormat') === '');
    now = 5123;
    await t.ctx.success('4901234567894', fmt('EAN_13'));
    check('診断: 成功時に経過時間・formatを含む直前1件を保持する', t.run('janSuccessElapsedMs') === 1623 && t.run('janSuccessFormat') === 'EAN_13' && /成功まで：1623 ms（1.6 秒）/.test(t.run('lastJanDiagnostics')) && /成功形式：EAN_13/.test(t.run('lastJanDiagnostics')));
    t.els.diagButton.listeners.click();
    check('診断: 成功後に開いても保持済みの設定・ROI・capabilitiesを確認できる', !t.els.diag.hidden() && /成功まで：1623 ms（1.6 秒）/.test(t.els.diag.textContent) && /成功形式：EAN_13/.test(t.els.diag.textContent) && /読取枠/.test(t.els.diag.textContent) && /対応範囲：未対応/.test(t.els.diag.textContent));
    t.els.diagButton.listeners.click();
    now = 6000;
    await t.start();
    now = 6300;
    await t.ctx.success('12345670', fmt('EAN_8'));
    check('診断: 次の成功で直前1件をEAN_8の最新結果へ更新する', /成功まで：300 ms（0.3 秒）/.test(t.run('lastJanDiagnostics')) && /成功形式：EAN_8/.test(t.run('lastJanDiagnostics')) && !/1623 ms/.test(t.run('lastJanDiagnostics')));
    t.els.diagButton.listeners.click();
    check('診断: 最新成功結果をあとから確認できる', /成功形式：EAN_8/.test(t.els.diag.textContent) && /成功まで：300 ms（0.3 秒）/.test(t.els.diag.textContent));
    now = 8000;
    const ts = load({ search: J, now: () => now, settings: { width: 1080, height: 1920, frameRate: 30, facingMode: 'environment', zoom: 2, focusMode: 'continuous', focusDistance: 0.4, exposureMode: 'continuous', exposureCompensation: 0, torch: false }, capabilities: { zoom: { min: 1, max: 4, step: 0.1 }, focusMode: ['continuous', 'manual'], torch: true }, video: { videoWidth: 1080, videoHeight: 1920 } });
    await ts.start(); ts.scannerCalls[0].startArgs.conf.qrbox(356, 633);
    now = 8500;
    await ts.ctx.success('4901234567894', fmt('EAN_13'));
    check('診断: 成功時スナップショットに設定値・映像・ROI・capabilities範囲を保持する', /1080×1920/.test(ts.run('lastJanDiagnostics')) && /読取枠：338×169（表示領域 356×633）/.test(ts.run('lastJanDiagnostics')) && /ズーム（設定値）：2／対応範囲：1〜4（step 0.1）/.test(ts.run('lastJanDiagnostics')) && /フォーカスモード（設定値）：continuous／対応範囲：continuous, manual/.test(ts.run('lastJanDiagnostics')));
    now = 9000;
    const te = load({ search: J, now: () => now, settings: { width: 1080, height: 1920 }, capabilitiesThrow: true });
    await te.start(); now = 9200;
    await te.ctx.success('4901234567894', fmt('EAN_13'));
    check('診断: capabilities取得例外でも成功結果を保持し、未対応として表示できる', /成功形式：EAN_13/.test(te.run('lastJanDiagnostics')) && /対応範囲：未対応/.test(te.run('lastJanDiagnostics')));
    /* jan_register以外では使えない */
    for (const search of ['', '?purpose=product_select&rid=' + UUID]) {
      const tq = load({ search });
      await tq.start();
      await tq.els.diagButton.listeners.click();
      check((search ? 'product_select' : 'inventory') + ': 診断は表示できない（内容が空・タイマーなし）', tq.els.diag.textContent === '' && tq.intervals.length === 0);
    }
    /* 静的：保存・外部通信・console出力なし */
    const diagSrc = (script.match(/function safeNum[\s\S]*?diagButton\.addEventListener\('click',toggleDiag\);/) || [''])[0];
    check('診断: 診断処理のソースがrid・app URL・requestId・qr・token等を参照しない', diagSrc.length > 300 && !/config\.requestId|appUrl|params|\bqr\b|token|sessionToken|location|document\.cookie/.test(diagSrc));
    check('診断: storage・Cookie・外部通信・consoleを使っていない（スクリプト全体）', !/localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|new Image\(/.test(script) && (script.match(/console\./g) || []).length === 1);
  }

  /* ===== 戻るボタン（管理者用途：product_select・jan_register） ===== */
  {
    const APP = 'https://example.invalid/app?x=1';
    for (const purpose of ['product_select', 'jan_register']) {
      const base = '?purpose=' + purpose + '&rid=' + UUID + '&app=' + encodeURIComponent(APP);
      /* openerあり */
      let t = load({ search: base, opener: 'ok' });
      await t.start();
      const ev = { prevented: 0, preventDefault() { this.prevented++; } };
      t.els.backButton.listeners.click(ev);
      await t.settle();
      check(purpose + ': openerあり：リンク遷移を止める', ev.prevented === 1);
      check(purpose + ': openerあり：カメラを停止してからopener.focus()を試す', t.scannerCalls[0].stopped === 1 && t.focused() === 1);
      check(purpose + ': openerあり：window.close()を試す', t.closed() === 1);
      check(purpose + ': openerあり：app URLへ移動しない（location.replaceなし）', t.replaced.length === 0);
      t.flush();
      check(purpose + ': openerあり：閉じられない場合は「元の棚卸画面のタブへ戻ってください」と案内', t.els.status.textContent === '元の棚卸画面のタブへ戻ってください。');
      /* openerなし */
      t = load({ search: base, opener: 'none' });
      await t.start();
      t.els.backButton.listeners.click({ preventDefault() {} });
      await t.settle();
      check(purpose + ': openerなし：遷移しない・closeも試さない', t.replaced.length === 0 && t.closed() === 0 && t.focused() === 0);
      check(purpose + ': openerなし：日本語で案内（戻れない場合はこのタブを閉じる）', t.els.status.textContent === '元の棚卸画面のタブへ戻ってください。戻れない場合はこのタブを閉じてください。');
      check(purpose + ': openerなし：カメラを安全に停止', t.scannerCalls[0].stopped === 1);
      check(purpose + ': 案内・戻るボタンにpurpose・rid・値・appを含まない', t.els.status.textContent.indexOf(UUID) < 0 && t.els.status.textContent.indexOf('example.invalid') < 0 && t.els.backButton.href === '');
      /* 二重クリック */
      t = load({ search: base, opener: 'ok' });
      await t.start();
      t.els.backButton.listeners.click({ preventDefault() {} });
      t.els.backButton.listeners.click({ preventDefault() {} });
      t.els.backButton.listeners.click({ preventDefault() {} });
      await t.settle();
      check(purpose + ': 二重クリックでstop・focus・closeを重複実行しない', t.scannerCalls[0].stopped === 1 && t.focused() === 1 && t.closed() === 1);
      t.flush();
      t.els.backButton.listeners.click({ preventDefault() {} });
      await t.settle();
      check(purpose + ': 処理が終わった後の再タップは再度closeを試せる', t.closed() === 2);
      /* 例外への安全性 */
      t = load({ search: base, opener: 'ok', stopThrows: true });
      await t.start();
      t.els.backButton.listeners.click({ preventDefault() {} });
      await t.settle(); t.flush();
      check(purpose + ': stopが失敗してもfocus・close・案内は動く', t.focused() === 1 && t.closed() === 1 && t.els.status.textContent === '元の棚卸画面のタブへ戻ってください。' && t.replaced.length === 0);
      t = load({ search: base, opener: 'focusThrow' });
      await t.start();
      t.els.backButton.listeners.click({ preventDefault() {} });
      await t.settle(); t.flush();
      check(purpose + ': opener.focus()が例外でもclose・案内は動く', t.focused() === 1 && t.closed() === 1 && t.els.status.textContent === '元の棚卸画面のタブへ戻ってください。');
      t = load({ search: base, opener: 'ok', closeThrows: true });
      await t.start();
      t.els.backButton.listeners.click({ preventDefault() {} });
      await t.settle(); t.flush();
      check(purpose + ': window.close()が例外でも案内を表示する', t.closed() === 1 && t.els.status.textContent === '元の棚卸画面のタブへ戻ってください。');
      /* カメラ未起動・appパラメータなしでも使える */
      t = load({ search: '?purpose=' + purpose + '&rid=' + UUID, opener: 'ok' });
      check(purpose + ': appパラメータが無くても戻るボタンを表示する', !t.els.backButton.hidden());
      t.els.backButton.listeners.click({ preventDefault() {} });
      await t.settle();
      check(purpose + ': カメラ未起動でも安全に閉じる・遷移しない', t.closed() === 1 && t.replaced.length === 0 && t.scannerCalls.length === 0);
    }
    /* 読取成功の既存動作は維持（postMessage→close） */
    for (const [purpose, val, f] of [['product_select', QR, 'QR_CODE'], ['jan_register', '4901234567894', 'EAN_13']]) {
      const t = load({ search: '?purpose=' + purpose + '&rid=' + UUID, opener: 'ok' });
      await t.start();
      await t.ctx.success(val, fmt(f));
      t.flush();
      check(purpose + ': 読取成功→postMessage（source・qr・id・format・purpose・requestId）→400ms後にclose', t.posted.length === 1 && Object.keys(t.posted[0].d).sort().join(',') === 'format,id,purpose,qr,requestId,source' && t.posted[0].o === '*' && t.closed() === 1 && t.pending(400) === 0);
    }
    /* inventoryは従来どおり */
    let ti = load({ search: '?app=' + encodeURIComponent(APP) });
    await ti.start();
    await ti.els.backButton.listeners.click({ preventDefault() {} });
    check('inventory: 戻るリンクはapp URLを持ち、従来どおりstopしてlocation.replaceする', ti.els.backButton.href === APP && ti.replaced[0] === APP && ti.scannerCalls[0].stopped === 1 && ti.focused() === 0 && ti.closed() === 0);
    ti = load({ search: '' });
    check('inventory: appが無ければ戻るボタンに処理を付けない（従来どおり）', Object.keys(ti.els.backButton.listeners).length === 0 && ti.els.backButton.href === '');
    check('静的: location.replaceは通常棚卸のフォールバックと通常棚卸の戻るだけ（管理者用途の戻る処理に無い）', (script.match(/location\.replace\(/g) || []).length === 2 && !/location\./.test((script.match(/async function goBackToOriginalTab[\s\S]*?\n  \}/) || [''])[0]));
    check('静的: 管理者用途の戻る処理がopener.focus()とwindow.close()を使う', /opener\.focus\(\)/.test(script) && /window\.close\(\)/.test((script.match(/async function goBackToOriginalTab[\s\S]*?\n  \}/) || [''])[0]));
  }

  /* ===== 画面 ===== */
  {
    let t = load({ search: '' });
    eq('inventory: 案内文', t.els.subtitle.textContent, '商品のQRコードを枠内に映してください');
    await t.start();
    eq('inventory: 読取中文言', t.els.status.textContent, '読み取り中です。QRコードを枠内に映してください。');
    t = load({ search: '?purpose=product_select&rid=' + UUID });
    eq('product_select: 案内文', t.els.subtitle.textContent, '登録先商品のQRコードを読み取ってください。');
    await t.start();
    eq('product_select: 読取中文言', t.els.status.textContent, '登録先商品のQRコードを読み取ってください。');
    t = load({ search: '?purpose=jan_register&rid=' + UUID });
    eq('jan_register: 案内文', t.els.subtitle.textContent, '商品のJANバーコードを横向きの枠に合わせてください。');
    await t.start();
    eq('jan_register: 読取中文言', t.els.status.textContent, '商品のJANバーコードを横向きの枠に合わせてください。');

    /* 読取枠 */
    let sc = await load({ search: '', innerWidth: 390 }).start();
    let qb = sc.startArgs.conf.qrbox;
    check('inventory: 正方形の枠', qb.width === qb.height);
    eq('inventory: 従来サイズ(390px)', qb.width, Math.min(Math.max(Math.floor(390 * .68), 220), 330));
    eq('inventory: aspectRatio従来どおり', sc.startArgs.conf.aspectRatio, 1);
    eq('inventory: fps従来どおり', sc.startArgs.conf.fps, 10);
    eq('inventory: environmentカメラ', sc.startArgs.cam.facingMode, 'environment');
    for (const w of [320, 375, 390, 414, 430]) {
      sc = await load({ search: '?purpose=jan_register&rid=' + UUID, innerWidth: w }).start();
      const V = w - 34; /* JAN画面の表示領域の幅（左右余白8px×2＋カード余白8px×2＋枠1px×2） */
      qb = sc.startArgs.conf.qrbox(V, Math.floor(V * 16 / 9));
      const oldEffective = Math.min(Math.min(Math.max(Math.floor(w * .82), 240), 360), w - 66);
      check('jan: 横長 (' + w + 'px)', qb.width > qb.height && qb.height > 0);
      check('jan: 幅は表示領域の90〜95% (' + w + 'px)', qb.width >= V * .9 - 1 && qb.width <= V * .95 + 1);
      check('jan: 表示領域を超えない・0や負数にならない・最小50px以上 (' + w + 'px)', qb.width <= V && qb.height <= Math.floor(V * 16 / 9) && qb.width >= 50 && qb.height >= 50);
      check('jan: 従来（旧qrbox＝' + oldEffective + 'px）より広い (' + w + 'px→' + qb.width + 'px)', qb.width > oldEffective);
    }
    sc = await load({ search: '?purpose=product_select&rid=' + UUID, innerWidth: 390 }).start();
    check('product_select: 正方形の枠', sc.startArgs.conf.qrbox.width === sc.startArgs.conf.qrbox.height);

    /* カメラエラー文言 */
    const errs = [
      [{ name: 'NotAllowedError' }, 'カメラが許可されていません。ブラウザのサイト設定で許可してください。'],
      [{ name: 'X', message: 'Permission denied' }, 'カメラが許可されていません。ブラウザのサイト設定で許可してください。'],
      [{ name: 'NotFoundError' }, '利用できるカメラが見つかりません。'],
      [{ name: 'NotReadableError' }, 'ほかのアプリがカメラを使用している可能性があります。'],
      [{ name: 'Other', message: 'boom' }, 'カメラを起動できませんでした。\nboom'],
      [{ name: 'Other' }, 'カメラを起動できませんでした。\nブラウザと権限を確認してください。']
    ];
    for (const purpose of ['', '?purpose=jan_register&rid=' + UUID, '?purpose=product_select&rid=' + UUID]) {
      for (const [e, msg] of errs) {
        t = load({ search: purpose, startError: e });
        await t.ctx.start();
        eq('カメラエラー文言 ' + (purpose || 'inventory').slice(0, 20) + ' ' + (e.name + (e.message || '')), t.els.status.textContent, msg);
        check('カメラエラー後に再起動可能', !t.els.startButton.hidden() && t.els.startButton.disabled === false);
      }
    }

    /* autostart */
    t = load({ search: '?autostart=1' });
    eq('autostart=1: 350ms後にstart予約', t.timers.length, 1);
    eq('autostart=1: 遅延350', t.timers[0].d, 350);
    t.flush(); await Promise.resolve();
    eq('autostart=1: カメラ起動', t.scannerCalls.length, 1);
    t = load({ search: '' });
    eq('autostartなしは自動起動しない', t.timers.length, 0);
    t = load({ search: '?autostart=0' });
    eq('autostart=0は自動起動しない', t.timers.length, 0);
    t = load({ search: '?purpose=jan_register&rid=' + UUID + '&autostart=1' });
    eq('jan+autostart: 起動予約', t.timers.length, 1);
    t = load({ search: '?purpose=jan_register&autostart=1' });
    eq('rid無し+autostart: 起動予約しない', t.timers.length, 0);
  }

  /* ===== 静的保護 ===== */
  {
    const scripts = html.match(/<script[^>]*src="[^"]*"/g) || [];
    eq('外部scriptは1つ', scripts.length, 1);
    eq('html5-qrcodeは2.3.8のまま', scripts[0], '<script src="https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js"');
    check('storage未使用', !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(script));
    check('sessionToken系をscriptで扱わない', !/sessionToken|session_token|productId|productName/i.test(script));
    check('consoleへ出すのは既存のstop警告のみ', (script.match(/console\./g) || []).length === 1 && /console\.warn\(error\)/.test(script));
    check('paramsから読むのはapp/autostart/purpose/ridのみ', (script.match(/params\.get\('([^']+)'\)/g) || []).map(s => s.slice(12, -2)).sort().join(',') === 'app,autostart,purpose,rid'
      || (script.match(/(?:params|p)\.(?:get|has)\('([^']+)'\)/g) || []).every(s => /'(app|autostart|purpose|rid)'/.test(s)));
    check('postMessageのtargetOriginは*', /\},'\*'\)/.test(script) && (script.match(/postMessage\(/g) || []).length === 1);
    check('inventoryの既存validQr式が不変', script.includes("function validQr(value){return /^[A-Z0-9][A-Z0-9-]{4,79}$/.test(value)}"));
    check('inventoryの既存destination式が不変', script.includes("function destination(qr){if(!appUrl)return '';return appUrl+(appUrl.includes('?')?'&':'?')+'qr='+encodeURIComponent(qr)+'&camera=1'}"));
    check('location.replaceはinventory経路と戻る操作のみ', (script.match(/location\.replace\(/g) || []).length === 2);
    check('newlyのlocation.replaceにvalue/ridを付けない', !/location\.replace\([^)]*(rid|requestId|purpose|jan)/i.test(script));
    check('既存の完了・多重送信ガード', /if\(completed\)return;/.test(script) && /completed=true;/.test(script));
  }

  console.log('\n' + (total - failed) + ' / ' + total + ' checks passed' + (failed ? ' (' + failed + ' FAILED)' : ''));
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
