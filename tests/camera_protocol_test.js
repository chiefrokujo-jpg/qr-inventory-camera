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

/* opts: {search, opener: 'ok'|'none'|'throw', startError} */
function load(opts) {
  opts = opts || {};
  const els = {};
  const timers = [];
  const posted = [];
  const replaced = [];
  const scannerCalls = [];
  let closed = 0;
  const ctx = {
    console, URLSearchParams, String, Math, Date, Object, Array, encodeURIComponent, Promise,
    innerWidth: opts.innerWidth || 390,
    location: { search: opts.search || '', replace: u => replaced.push(u) },
    navigator: { vibrate() {} },
    setTimeout: (f, d) => { timers.push({ f, d }); return timers.length; },
    addEventListener() {},
    document: { getElementById: id => els[id] || (els[id] = makeEl()) },
    Html5QrcodeSupportedFormats: { QR_CODE: 0, EAN_13: 7, EAN_8: 6 },
    Html5Qrcode: function (id, cfg) {
      this.cfg = cfg; scannerCalls.push(this);
      this.start = async (cam, conf, ok) => {
        this.startArgs = { cam, conf, ok };
        if (opts.startError) throw opts.startError;
      };
      this.stop = async () => { this.stopped = (this.stopped || 0) + 1; };
      this.clear = async () => {};
    }
  };
  ctx.window = ctx;
  ctx.crypto = { randomUUID: () => 'uuid-' + posted.length };
  if (opts.opener === 'ok') ctx.opener = { closed: false, postMessage: (d, o) => posted.push({ d, o }) };
  else if (opts.opener === 'throw') ctx.opener = { closed: false, postMessage() { throw new Error('x'); } };
  else ctx.opener = null;
  ctx.close = () => { closed++; };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return {
    ctx, els, timers, posted, replaced, scannerCalls,
    closed: () => closed,
    run: code => vm.runInContext(code, ctx),
    async start() { await ctx.start(); return scannerCalls[scannerCalls.length - 1]; },
    flush() { const t = timers.splice(0); t.forEach(x => x.f()); }
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
        check(tag + ': 戻るリンクに値・rid・purposeを含まない', t.els.backButton.href === APP && !t.els.backButton.href.includes(val));
        eq(tag + ': closeしない', t.closed(), 0);
      }
    }
    /* 戻るリンクはpurposeに関係なく値を含まない */
    t = load({ search: '?purpose=jan_register&rid=' + UUID + '&app=' + encodeURIComponent(APP) });
    eq('jan: 戻るリンクhref=app', t.els.backButton.href, APP);
    await t.start();
    await t.ctx.success('4901234567894', fmt('EAN_13'));
    await t.els.backButton.listeners.click({ preventDefault() {} });
    eq('jan: 完了後の戻るリンクは明示タップで遷移', t.replaced[0], APP);
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
    for (const w of [320, 360, 390, 430, 768, 1200]) {
      sc = await load({ search: '?purpose=jan_register&rid=' + UUID, innerWidth: w }).start();
      qb = sc.startArgs.conf.qrbox;
      check('jan: 横長 (' + w + 'px)', qb.width > qb.height);
      check('jan: 最小幅・最大幅 (' + w + 'px)', qb.width >= 240 && qb.width <= 360);
      if (w >= 320 && w <= 430) check('jan: 縦画面からはみ出さない (' + w + 'px)', qb.width <= w - 32);
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
