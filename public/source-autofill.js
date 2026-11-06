export const sourceFieldNames = { appName: '应用显示名', appId: 'DCloud AppID', packageName: 'Android 包名', versionName: '版本名称', versionCode: '版本码' };
export const sourceFields = Object.keys(sourceFieldNames);
const defaults = { appName: '新应用', name: '新项目' };
// Only blanks, untouched defaults and values previously filled by us can change automatically.
export function planSourceFill(current, incoming, { previous = {}, snapshot = current, replace = false, touched = new Set() } = {}) {
  const updates = {}, conflicts = [], kept = [];
  for (const key of [...sourceFields, 'name', 'frontendMode']) {
    const value = incoming[key] || '', existing = current[key] || '';
    const automatic = Object.hasOwn(previous, key) && existing === previous[key] && !touched.has(key);
    const mayChange = replace || !existing || !touched.has(key) && (existing === defaults[key] || key === 'frontendMode' && !previous[key]);
    if (existing !== (snapshot[key] || '')) { if (value && value !== existing && key !== 'name') conflicts.push(key); continue; }
    if (value && value !== existing) {
      if (key === 'name' ? !existing || existing === defaults.name || automatic : mayChange || automatic) updates[key] = value;
      else if (key !== 'name') { conflicts.push(key); kept.push(key); }
    } else if (!value && automatic && key !== 'frontendMode') updates[key] = '';
  }
  return { updates, conflicts, kept };
}
