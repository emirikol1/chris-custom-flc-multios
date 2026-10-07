'use strict';

const zlib = require('zlib');
const { PROMPT_GLOW_COLORS, normalizePromptGlow, normalizePromptGlowStrength } = require('./center-prompts');

/**
 * Menu bar for the main game window. Popouts keep the hidden default.
 * Custom items are Full Refresh, the center-prompts checkbox, and the highlight submenu.
 * The rest match Electron's usual View menu.
 *
 * @param {{
 *   centerPrompts?: boolean,
 *   promptHighlight?: boolean,
 *   promptAutoRaise?: boolean,
 *   promptGlow?: string,
 *   promptGlowStrength?: number,
 *   onToggleCenterPrompts?: (enabled: boolean) => void,
 *   onTogglePromptHighlight?: (enabled: boolean) => void,
 *   onTogglePromptAutoRaise?: (enabled: boolean) => void,
 *   onPickPromptGlow?: (glow: string) => void,
 *   onPickPromptGlowStrength?: () => void,
 *   onFullRefresh?: () => void,
 *   verboseLogging?: boolean,
 *   onOpenWorldStats?: () => void,
 *   bringAllToFront?: (win?: object) => void,
 *   onToggleVerboseLogging?: (enabled: boolean) => void,
 *   onOpenLogs?: () => void,
 *   onOpenProblemLog?: () => void,
 *   onCopyTroubleshooting?: () => void,
 *   onSaveDiagnostics?: () => void,
 *   platform?: string,
 * }} [opts]
 */
function gameWindowMenuTemplate({
  centerPrompts = true,
  promptHighlight = true,
  promptAutoRaise = true,
  promptGlow = 'blue',
  promptGlowStrength = 100,
  verboseLogging = false,
  onToggleCenterPrompts,
  onTogglePromptHighlight,
  onTogglePromptAutoRaise,
  onPickPromptGlow,
  onPickPromptGlowStrength,
  onFullRefresh,
  onOpenWorldStats,
  bringAllToFront,
  onToggleVerboseLogging,
  onOpenLogs,
  onOpenProblemLog,
  onCopyTroubleshooting,
  onSaveDiagnostics,
  platform,
} = {}) {
  const glow = normalizePromptGlow(promptGlow);
  const strength = normalizePromptGlowStrength(promptGlowStrength);
  const template = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        {
          id: 'full-refresh',
          label: 'Full Refresh (clear cache)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click() {
            onFullRefresh && onFullRefresh();
          },
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          id: 'diagnostics',
          label: 'Diagnostics',
          submenu: [
            {
              id: 'world-stats',
              label: 'World Statistics…',
              accelerator: 'CmdOrCtrl+Shift+S',
              click() {
                if (typeof onOpenWorldStats === 'function') onOpenWorldStats();
              },
            },
            bringAllToFrontMenuItem(bringAllToFront),
            { type: 'separator' },
            {
              id: 'verbose-logging',
              label: 'Verbose logging (this session)',
              type: 'checkbox',
              checked: verboseLogging === true,
              click(menuItem) {
                if (typeof onToggleVerboseLogging !== 'function') return;
                onToggleVerboseLogging(Boolean(menuItem && menuItem.checked));
              },
            },
            {
              id: 'open-logs',
              label: 'Open logs folder',
              click() {
                if (typeof onOpenLogs === 'function') onOpenLogs();
              },
            },
            {
              id: 'open-problem-log',
              label: 'Open problem log',
              click() {
                if (typeof onOpenProblemLog === 'function') onOpenProblemLog();
              },
            },
            {
              id: 'copy-ts',
              label: 'Copy troubleshooting info',
              click() {
                if (typeof onCopyTroubleshooting === 'function') onCopyTroubleshooting();
              },
            },
            {
              id: 'save-diagnostics',
              label: 'Save diagnostics file…',
              click() {
                if (typeof onSaveDiagnostics === 'function') onSaveDiagnostics();
              },
            },
          ],
        },
        { type: 'separator' },
        {
          id: 'center-prompts',
          label: 'Prompt windows always on main window',
          type: 'checkbox',
          checked: centerPrompts !== false,
          click(menuItem) {
            if (typeof onToggleCenterPrompts !== 'function') return;
            onToggleCenterPrompts(Boolean(menuItem && menuItem.checked));
          },
        },
        {
          id: 'prompt-highlight',
          label: 'Highlight Prompts',
          submenu: [
            {
              id: 'prompt-highlight-toggle',
              label: 'Highlight Prompts',
              type: 'checkbox',
              checked: promptHighlight !== false,
              click(menuItem) {
                if (typeof onTogglePromptHighlight !== 'function') return;
                onTogglePromptHighlight(Boolean(menuItem && menuItem.checked));
              },
            },
            {
              id: 'prompt-auto-raise',
              label: 'Auto-Raise',
              type: 'checkbox',
              checked: promptAutoRaise !== false,
              click(menuItem) {
                if (typeof onTogglePromptAutoRaise !== 'function') return;
                onTogglePromptAutoRaise(Boolean(menuItem && menuItem.checked));
              },
            },
            { type: 'separator' },
            ...PROMPT_GLOW_COLORS.map((color) => {
              /** @type {{ id: string, label: string, type: 'radio', checked: boolean, icon?: Electron.NativeImage, click: () => void }} */
              const item = {
                id: `prompt-glow-${color.id}`,
                label: color.label,
                type: 'radio',
                checked: glow === color.id,
                click() {
                  if (typeof onPickPromptGlow !== 'function') return;
                  onPickPromptGlow(color.id);
                },
              };
              const icon = glowSwatch(color.swatch);
              if (icon) item.icon = icon;
              return item;
            }),
            { type: 'separator' },
            {
              id: 'prompt-glow-strength',
              label: `Glow Strength: ${strength}%`,
              click() {
                if (typeof onPickPromptGlowStrength !== 'function') return;
                onPickPromptGlowStrength();
              },
            },
          ],
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  if (platform === 'darwin') template.unshift({ role: 'appMenu' });
  return template;
}

/**
 * macOS menu for the join window and every other non-game window.
 * Prompt, glow, and diagnostics items stay on the game menu only.
 * @param {{ bringAllToFront?: (win?: object) => void }} [opts]
 * @returns {Array<object>}
 */
function plainAppMenuTemplate({ bringAllToFront } = {}) {
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        bringAllToFrontMenuItem(bringAllToFront),
      ],
    },
    { role: 'windowMenu' },
  ];
}

/**
 * @param {(win?: object) => void} [bringAllToFront]
 * @returns {object}
 */
function bringAllToFrontMenuItem(bringAllToFront) {
  return {
    id: 'bring-all-to-front',
    label: 'Bring All FLC Windows to Front',
    accelerator: 'CmdOrCtrl+Shift+U',
    click(_menuItem, browserWindow) {
      if (typeof bringAllToFront === 'function') bringAllToFront(browserWindow);
    },
  };
}

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

/**
 * Tiny solid swatch so the menu shows the color, not only its name.
 * @param {string} hex
 * @returns {Buffer}
 */
function solidPng(hex) {
  const size = 16;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const i = row + 1 + x * 4;
      const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      raw[i] = edge ? 50 : r;
      raw[i + 1] = edge ? 50 : g;
      raw[i + 2] = edge ? 50 : b;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {string} hex
 * @returns {Electron.NativeImage | undefined}
 */
function glowSwatch(hex) {
  try {
    const { nativeImage } = require('electron');
    return nativeImage.createFromBuffer(solidPng(hex));
  } catch {
    return undefined;
  }
}

module.exports = {
  gameWindowMenuTemplate,
  plainAppMenuTemplate,
  solidPng,
};
