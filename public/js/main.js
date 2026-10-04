import { loadTranscodeTab } from './airspec.js';
import { loadAnalogTab, scheduleAnalogPoll } from './analog.js';
import { loadCatalogTab } from './catalog.js';
import { $, $$, toast } from './core.js';
import { loadMediaTab } from './media.js';
import { loadMonitorTab, scheduleMonitorPoll } from './monitor.js';
import { loadSchedule } from './schedule.js';
import { loadSetupTab } from './setup.js';

// ---- Tabs ------------------------------------------------------------------
$$('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('nav button').forEach((x) => x.classList.remove('active'));
    $$('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(`#tab-${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'media') loadMediaTab();
    if (b.dataset.tab === 'catalog') loadCatalogTab();
    if (b.dataset.tab === 'setup') loadSetupTab();
    if (b.dataset.tab === 'transcode') loadTranscodeTab();
    if (b.dataset.tab === 'analog') { loadAnalogTab().catch((e) => toast(e.message, 'bad', 'Analog')); scheduleAnalogPoll(); }
    if (b.dataset.tab === 'monitor') { loadMonitorTab().catch((e) => toast(e.message, 'bad', 'Error')); scheduleMonitorPoll(); }
  })
);

// ---- Boot ------------------------------------------------------------------
loadSchedule();

