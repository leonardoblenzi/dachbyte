const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("C:/Users/USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const root = "C:/Users/USER/Documents/Projetos/davantti/ml";

async function main() {
  let html = await fs.readFile(path.join(root, "views/publicidade.html"), "utf8");
  const cssApp = await fs.readFile(path.join(root, "public/css/ml-app.css"), "utf8");
  const cssAds = await fs.readFile(path.join(root, "public/css/product-ads.css"), "utf8");

  html = html
    .replace(/<link[^>]+ml-app\.css[^>]*>/i, `<style>${cssApp}</style>`)
    .replace(/<link[^>]+product-ads\.css[^>]*>/i, `<style>${cssAds}</style>`)
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js"><\/script>/i, "")
    .replace(/<script src="\/ml\/js\/ml-base\.js[^>]*><\/script>/i, "")
    .replace(/<script src="\/ml\/js\/product-ads\.js[^>]*><\/script>/i, "");

  const mockScript = `
<style>
  body{background:#f3f6fb;}
  .preview-chart{height:100%;min-height:360px;display:block;width:100%;}
  .preview-chart svg{width:100%;height:100%;display:block;}
</style>
<script>
(function(){
  const set=(id,v)=>{const el=document.getElementById(id); if(el) el.textContent=v;};
  const dF=document.getElementById('dateFrom'); if(dF) dF.value='2026-04-01';
  const dT=document.getElementById('dateTo'); if(dT) dT.value='2026-04-27';
  set('premiumPeriod','Periodo: 2026-04-01 a 2026-04-27');
  set('rankingPeriod','Periodo: 2026-04-01 a 2026-04-27');
  set('pillRange','2026-04-01 -> 2026-04-27');
  set('kpiRevenue','R$ 184.920,40'); set('kpiCost','R$ 18.470,12'); set('kpiRoas','10,01x'); set('kpiAcos','9,99%');
  set('kpiClicks','24.618'); set('kpiPrints','1.482.900'); set('kpiCtr','1,66%'); set('kpiCpc','R$ 0,75');
  set('tableCount','27 dias');
  const chart=document.getElementById('adsMetricsChart');
  if(chart){
    const wrap=chart.parentElement; chart.remove();
    wrap.innerHTML='<div class="preview-chart"><svg viewBox="0 0 900 420" role="img" aria-label="Grafico de faturamento"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity="0.28"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0.02"/></linearGradient></defs><rect width="900" height="420" rx="18" fill="#f7fbff"/><g stroke="#cbd5e1" stroke-opacity=".55"><path d="M60 70H850M60 140H850M60 210H850M60 280H850M60 350H850"/><path d="M120 52V360M220 52V360M320 52V360M420 52V360M520 52V360M620 52V360M720 52V360M820 52V360"/></g><path d="M70 326 C130 290 155 296 210 238 C270 176 320 206 380 148 C445 86 510 132 570 104 C635 72 695 154 760 98 C805 62 828 74 850 58 L850 360 L70 360 Z" fill="url(#g)"/><path d="M70 326 C130 290 155 296 210 238 C270 176 320 206 380 148 C445 86 510 132 570 104 C635 72 695 154 760 98 C805 62 828 74 850 58" fill="none" stroke="#3b82f6" stroke-width="5" stroke-linecap="round"/><path d="M70 342 C145 315 180 328 240 280 C310 220 372 246 430 190 C498 132 560 185 620 152 C690 120 738 190 800 148" fill="none" stroke="#3b82f6" stroke-width="3" stroke-dasharray="10 10" stroke-opacity=".5"/><g fill="#1e293b" font-family="Segoe UI" font-size="18" font-weight="700"><text x="80" y="48">Faturamento diario</text><text x="740" y="395">Abril 2026</text></g></svg></div>';
  }
  const daily=document.getElementById('tbodyDaily');
  if(daily) daily.innerHTML=['01|R$ 5.840,20|R$ 612,40|812|48.900|1,66%|R$ 0,75|9,54x|10,49%','02|R$ 7.120,90|R$ 701,80|954|54.210|1,76%|R$ 0,74|10,15x|9,86%','03|R$ 6.480,00|R$ 655,10|881|51.602|1,71%|R$ 0,74|9,89x|10,11%','04|R$ 8.230,70|R$ 790,44|1.026|62.118|1,65%|R$ 0,77|10,41x|9,60%','05|R$ 9.810,10|R$ 913,22|1.188|71.340|1,67%|R$ 0,77|10,74x|9,31%'].map(r=>'<tr>'+r.split('|').map((c,i)=>'<td class="'+(i?'num':'')+'">'+c+'</td>').join('')+'</tr>').join('');
  const camp=document.getElementById('tbodyCampaigns');
  if(camp) camp.innerHTML=[
    ['Campanha Drossi Abril','active','profitability','R$ 280,00','8,00x','10,82x','426','262.410','4.982','R$ 3.716,20','R$ 0,75','1,90%','R$ 40.210,90','9,24%'],
    ['Linha Premium Jardim','active','increase_sales','R$ 180,00','6,00x','7,44x','318','188.920','3.106','R$ 2.890,50','R$ 0,93','1,64%','R$ 21.520,00','13,43%'],
    ['Curva B Casa','paused','profitability','R$ 95,00','10,00x','4,18x','74','61.830','807','R$ 970,10','R$ 1,20','1,31%','R$ 4.056,20','23,92%']
  ].map((r,idx)=>'<tr data-camp-id="'+idx+'" class="'+(idx===0?'is-selected':'')+'"><td class="sticky-col"><div class="camp-row-main"><button class="ads-campaign-row-toggle '+(r[1]==='active'?'is-active':'is-paused')+'"><span class="ads-campaign-row-toggle__track"><span class="ads-campaign-row-toggle__thumb"></span></span></button><div class="camp-name"><span class="camp-title">'+r[0]+'</span><div class="camp-sub"><span class="camp-sub__line">'+(idx+4)+' adgroups</span><span class="camp-sub__line">Data de criacao: 0'+(idx+2)+'/04/2026</span></div></div></div></td><td><span class="pill '+(r[1]==='active'?'pill--active':'pill--paused')+'">* '+r[1]+'</span></td><td><span class="pill pill--profit">'+r[2]+'</span></td>'+r.slice(3).map((c,i)=>'<td class="num">'+(i<2?'<div class="ads-table-inline-edit"><span>'+c+'</span><button class="ads-table-edit-btn"></button></div>':c)+'</td>').join('')+'<td><div class="ads-inline-actions"><button class="ads-inline-btn">Editar</button><button class="ads-inline-btn ads-inline-btn--ghost">Grafico</button></div></td></tr>').join('');
  const items=document.getElementById('tbodyItems');
  if(items) items.innerHTML=[
    ['Mesa lateral Drossi Freijo','SKU-4421','MLB3489127601','92','8,7%','11,46x','R$ 4.820,00','R$ 420,60'],
    ['Banco jardim em madeira macica','SKU-1190','MLB3380012771','84','11,2%','8,91x','R$ 3.190,90','R$ 357,90'],
    ['Cachepot premium area externa','SKU-9022','MLB3298761140','66','15,9%','6,28x','R$ 2.102,40','R$ 334,70']
  ].map((r,i)=>'<tr><td class="sticky-col"><div class="ads-item-product"><div class="ads-item-thumb"><span>'+r[0][0]+'</span></div><div class="ads-item-info"><div class="ads-item-title">'+r[0]+'</div><div class="ads-item-meta"><span>SKU: '+r[1]+'</span><span>MLB: '+r[2]+'</span><span class="ads-item-status is-active">active</span></div></div></div></td><td class="num"><div class="quality-badge '+(i<2?'quality-badge--good':'quality-badge--medium')+'">'+r[3]+'</div></td><td class="num">'+r[4]+'</td><td class="num">-</td><td class="num">'+r[5]+'</td><td class="num">48.200</td><td class="num">812</td><td class="num">1,68%</td><td class="num">R$ 0,72</td><td class="num">4,8%</td><td class="num">'+r[6]+'</td><td class="num">R$ 1.240,00</td><td class="num">R$ 860,00</td><td class="num">42</td><td class="num">R$ 116,00</td><td class="num">'+r[7]+'</td><td><div class="ads-inline-actions"><button class="ads-inline-btn ads-inline-btn--danger">Remover</button><button class="ads-inline-btn ads-inline-btn--ghost">Pausar</button></div></td></tr>').join('');
})();
</script>`;

  html = html.replace("</body>", `${mockScript}</body>`);
  const previewPath = path.join(root, "tmp/publicidade-preview.html");
  const imagePath = path.join(root, "tmp/publicidade-preview.png");
  await fs.writeFile(previewPath, html, "utf8");

  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1300 }, deviceScaleFactor: 1 });
  await page.goto(`file://${previewPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
  await page.screenshot({ path: imagePath, fullPage: false });
  await browser.close();
  console.log(imagePath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
