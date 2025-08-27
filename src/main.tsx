import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Tauri compatibility shim: defines window.electron / window.freelyDB when running under Tauri
import './tauri-shim'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)