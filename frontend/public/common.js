/* common.js — haddii server-ku ma socdo (ama bogga si toos ah loo furay), farriin cad ayaa soo baxda */
(function () {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(8,10,13,.97);z-index:9999;display:none;align-items:center;justify-content:center;padding:20px;font-family:Segoe UI,Arial,sans-serif';
  ov.innerHTML = `<div style="max-width:620px;background:#161b22;border:1px solid #df294a;border-radius:10px;padding:28px;color:#e1e4e6;line-height:1.55">
    <h2 style="margin:0 0 10px;color:#ff6b81">⚠ Barnaamijka (server-ka) ma socdo</h2>
    <div id="ovmsg"></div>
    <ol style="padding-left:20px"><li><b>itr-forex-terminal.exe</b> double-click ku dhufo — <i>ama</i> <b>start.bat</b> (waxay u baahan tahay Node.js 18+)</li>
    <li>Daaqadda madow (console) ha xidhin — waa inay furan tahay</li><li>Browser-ka ka fur: <a href="http://localhost:4100" style="color:#4f9bf7">http://localhost:4100</a></li></ol>
    <div style="color:#8a96a3;font-size:12px">Ha furin <code>index.html</code> si toos ah (double-click) — suuqyada, trading-ka, History-ga iyo faylasha folders-ka waxay ka yimaadaan server-ka oo kaliya.</div>
    <div style="margin-top:14px"><a href="http://localhost:4100" style="background:#4f9bf7;color:#0c0f12;padding:9px 16px;border-radius:5px;font-weight:bold;text-decoration:none">Isku day mar kale</a></div></div>`;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(ov));
  const show = m => { ov.style.display = 'flex'; ov.querySelector('#ovmsg').innerHTML = m || '' }, hide = () => { ov.style.display = 'none' };
  if (location.protocol === 'file:') { document.addEventListener('DOMContentLoaded', () => show('<b>Faylkan si toos ah ayaad u furtay (file://).</b> Waa inaad marka hore server-ka shido.')); return }
  const of = window.fetch; let fails = 0;
  window.fetch = (...a) => of(...a).then(r => { fails = 0; hide(); return r }).catch(e => { if (++fails >= 2) show('Isku-xirka server-ka waa go\'ay.'); throw e });
})();
