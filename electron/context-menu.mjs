/** Build native editing/spelling actions from Electron's actual right-click data.
 * @param {Electron.ContextMenuParams} params
 * @param {Electron.WebContents} contents
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function editingMenu(params, contents) {
  const flags = params.editFlags;
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [];
  if (params.isEditable && params.formControlType !== 'input-password' && params.misspelledWord) {
    const suggestions = [...new Set(params.dictionarySuggestions || [])].filter(word => typeof word === 'string' && word).slice(0, 8);
    if (suggestions.length) for (const suggestion of suggestions) items.push({ label: suggestion, click: () => { if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion); } });
    else items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({ type: 'separator' });
  }
  if (params.isEditable) items.push(
    { role: 'undo', enabled: !!flags.canUndo }, { role: 'redo', enabled: !!flags.canRedo }, { type: 'separator' },
    { role: 'cut', enabled: !!flags.canCut }, { role: 'copy', enabled: !!flags.canCopy },
    { role: 'paste', enabled: !!flags.canPaste }, { type: 'separator' }, { role: 'selectAll', enabled: !!flags.canSelectAll },
  );
  else if (params.selectionText) items.push({ role: 'copy', enabled: !!flags.canCopy }, { role: 'selectAll', enabled: !!flags.canSelectAll });
  return items;
}
