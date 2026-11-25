const { contextBridge, ipcRenderer } = require('electron');

// The tasks window gets only these functions, nothing else
contextBridge.exposeInMainWorld('tasksApi', {
  list: () => ipcRenderer.invoke('tasks:list'),
  add: input => ipcRenderer.invoke('tasks:add', input),
  toggle: id => ipcRenderer.invoke('tasks:toggle', id),
  remove: id => ipcRenderer.invoke('tasks:remove', id),
  clearDone: () => ipcRenderer.invoke('tasks:clear-done'),
  onChanged: callback => ipcRenderer.on('tasks:changed', () => callback()),
});
