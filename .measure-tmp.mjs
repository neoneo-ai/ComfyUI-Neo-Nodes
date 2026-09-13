import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto('file:///C:/Users/tony/AppData/Local/Temp/neo-dl-harness8/harness.html');
await p.waitForTimeout(100);
const r = await p.evaluate(() => {
  const g = id => document.getElementById(id).getBoundingClientRect();
  const char = g('charcol'), bg = g('bgcol'), bgG = g('bggrid'), t1 = g('bgT1');
  const bgGrid = document.querySelector('#bggrid');
  const charGrid = document.querySelector('#charcol .neo-director-refgrid');
  return {
    sameRow: { charTop: char.top, bgTop: bg.top, charBottom: char.bottom, bgBottom: bg.bottom },
    bgColWidth: bg.width, bgColLeft: bg.left, charColWidth: char.width,
    bgGridCols: getComputedStyle(bgGrid).gridTemplateColumns,
    thumb: { w: t1.width, h: t1.height, ratio: (t1.width / t1.height).toFixed(3) },
    charGridWidth: charGrid.getBoundingClientRect().width,
    charGridCols: getComputedStyle(charGrid).gridTemplateColumns,
    bodyW: document.querySelector('.neo-director-body').getBoundingClientRect().width,
  };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
