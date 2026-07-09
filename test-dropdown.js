const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const requests = [];
  page.on('request', (req) => { if (req.url().includes('/api/dados')) requests.push(req.url()); });

  await page.goto('http://localhost:3000');
  await page.waitForSelector('#statusBadge');

  console.log('menu aberto antes do clique:', await page.locator('#periodoDropdown').evaluate(el=>el.classList.contains('open')));
  await page.click('#periodoBtn');
  console.log('menu aberto depois do clique:', await page.locator('#periodoDropdown').evaluate(el=>el.classList.contains('open')));
  console.log('opcoes visiveis:', await page.locator('#periodoMenu li[role=option]').allTextContents());

  await page.screenshot({ path: 'dropdown-aberto.png' });

  requests.length = 0;
  await page.click('#periodoMenu li[data-value="intervalo"]');
  await page.waitForTimeout(200);
  console.log('label apos escolher intervalo:', await page.locator('#periodoLabel').textContent());
  console.log('menu fechou:', !(await page.locator('#periodoDropdown').evaluate(el=>el.classList.contains('open'))));
  console.log('campos intervalo visiveis:', await page.locator('#dataInicio').isVisible(), await page.locator('#dataFim').isVisible());

  await page.fill('#dataInicio','2026-06-01');
  await page.fill('#dataFim','2026-06-30');
  await page.waitForTimeout(300);
  console.log('req intervalo:', requests.at(-1));

  await page.click('body');
  await page.click('#periodoBtn');
  await page.click('#periodoMenu li[data-value="hoje"]');
  await page.waitForTimeout(200);
  console.log('label apos hoje:', await page.locator('#periodoLabel').textContent());
  console.log('aria-selected hoje:', await page.locator('#periodoMenu li[data-value="hoje"]').getAttribute('aria-selected'));

  await browser.close();
})();
