export const STATIC_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>角色属性求值服务</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0e1116;
      --panel: #161b22;
      --panel-2: #1c232c;
      --line: #2a323d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #4cc2ff;
      --good: #3fb950;
      --warn: #d29922;
      --bad: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 "Inter", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif;
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .topbar {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 24px;
      padding: 20px 28px 12px;
    }
    h1 { margin: 0; font-size: 20px; letter-spacing: 0.02em; }
    h2 { margin: 18px 0 10px; font-size: 15px; color: var(--muted); font-weight: 600; }
    h3 { margin: 18px 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; }
    .subtitle { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
    .state { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge { border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--muted); }
    .badge.accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
    .notice {
      margin: 0 28px 8px; padding: 8px 12px; border-radius: 8px;
      background: color-mix(in srgb, var(--accent) 12%, var(--panel));
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
      font-size: 13px;
    }
    .loadout-bar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 10px 28px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .section-label { color: var(--muted); font-size: 12px; margin-right: 4px; }
    .spacer { flex: 1; }
    button { font: inherit; cursor: pointer; }
    .loadout, .ghost {
      border: 1px solid var(--line); background: var(--panel-2); color: var(--text);
      border-radius: 8px; padding: 5px 12px; font-size: 13px;
    }
    .loadout.active { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--panel-2)); }
    .ghost:hover, .loadout:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
    .ghost:disabled { opacity: 0.45; cursor: not-allowed; }
    .layout {
      display: grid; grid-template-columns: 260px minmax(0, 1fr) 340px; gap: 16px;
      padding: 16px 28px 40px; align-items: start;
    }
    .attributes, .detail, .sidebar > section { }
    .attribute-grid { display: flex; flex-direction: column; gap: 8px; }
    .attribute-card {
      display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 8px;
      text-align: left; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line);
      background: var(--panel); color: var(--text);
    }
    .attribute-card.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--panel)); }
    .attribute-name { font-size: 13px; color: var(--muted); grid-column: 1; }
    .attribute-value { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; grid-column: 2; grid-row: 1 / span 2; }
    .attribute-meta { font-size: 11px; color: var(--muted); grid-column: 1; }
    .detail {
      background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px;
      min-height: 320px;
    }
    .description { color: var(--muted); margin: 4px 0 14px; }
    .detail-value { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .detail-value strong { font-size: 32px; font-variant-numeric: tabular-nums; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; color: var(--muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--line); }
    td { padding: 7px 8px; border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); vertical-align: top; }
    tr.inactive td { color: var(--muted); }
    tr.shadowed td { color: var(--muted); }
    tr.shadowed td:nth-child(5) { text-decoration: line-through; }
    .source-list, .effect-list, .edge-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .source, .effect, .edge {
      background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px;
    }
    .source-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .source-label { font-size: 13px; }
    .tag { font-size: 11px; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 999px; padding: 1px 7px; }
    .tag.muted { color: var(--muted); border-color: var(--line); }
    .source-meta { color: var(--muted); font-size: 11px; margin-top: 4px; }
    .effect button { margin-top: 8px; }
    .issues { list-style: none; padding: 0; margin: 0 0 10px; display: flex; flex-direction: column; gap: 6px; }
    .issue { font-size: 12px; color: var(--muted); }
    .issue .tag { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); margin-right: 6px; }
    .sidebar h2 { margin-top: 20px; }
    .source.pressure { border-color: color-mix(in srgb, var(--warn) 30%, var(--line)); }
    .source.buff { border-color: color-mix(in srgb, var(--good) 30%, var(--line)); }
    .edge-arrow { font-family: ui-monospace, monospace; font-size: 12px; color: var(--accent); }
    @media (max-width: 1080px) {
      .layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script src="./app.js"></script>
</body>
</html>
`;
