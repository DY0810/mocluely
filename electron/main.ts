import { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, systemPreferences } from 'electron'
import * as path from 'path'
import * as process from 'process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Hide from dock (macOS) — combined with LSUIElement in package.json,
// this hides from Cmd+Tab, Force Quit, and Activity Monitor's "windowed" list
// if (app.dock) {
//     app.dock.hide()
// }

let win: BrowserWindow | null = null
let isGhostMode = false

function createWindow() {
    win = new BrowserWindow({
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        skipTaskbar: true,         // Hide from Windows taskbar too
        width: 420,
        height: 650,
        x: 80,
        y: 80,
        type: 'panel',             // macOS: prevents showing in Mission Control
    })

    // CRITICAL: Screen-sharing invisibility
    win.setContentProtection(true)
    win.setAlwaysOnTop(true, 'screen-saver', 1)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    // Development vs Production loading
    if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(process.env.VITE_DEV_SERVER_URL)
    } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'))
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
        win = null
    }
})

app.whenReady().then(async () => {
    // Explicitly ask for microphone access on macOS to trigger the system prompt
    if (process.platform === 'darwin') {
        try {
            const micStatus = systemPreferences.getMediaAccessStatus('microphone');
            console.log("Current Microphone status:", micStatus);
            if (micStatus !== 'granted') {
                await systemPreferences.askForMediaAccess('microphone');
            }
        } catch (e) {
            console.error("Failed to ask for mic access:", e);
        }
    }

    createWindow()

    // Handle quit from the UI
    ipcMain.on('quit-app', () => {
        app.quit()
    })

    // IPC handler for on-demand screen thumbnail capture
    ipcMain.handle('capture-screen-on-demand', async () => {
        try {
            // macOS stealth screen recording fetch
            const sources = await desktopCapturer.getSources({
                types: ['screen', 'window'],
                thumbnailSize: { width: 1280, height: 800 }
            })
            console.log(`[Screen] Found ${sources.length} potential sources.`);
            const screenSource = sources.find((s: any) => s.id.startsWith('screen')) || sources[0]
            if (screenSource) {
                console.log(`[Screen] Selected source: ${screenSource.name} (${screenSource.id})`);
            }
            if (screenSource && screenSource.thumbnail) {
                // NativeImage 'toDataURL' returns data:image/png;base64,...
                return screenSource.thumbnail.toDataURL().split(',')[1]
            }
            return null
        } catch (error) {
            console.error("Failed to capture screen:", error)
            return null
        }
    })

    // Handle initial ghost mode state fetch
    ipcMain.handle('get-ghost-mode', () => {
        return isGhostMode;
    })

    // Register global shortcut to toggle visibility
    globalShortcut.register('CommandOrControl+Shift+H', () => {
        if (win && !win.isDestroyed()) {
            if (win.isVisible()) {
                win.hide()
            } else {
                win.show()
            }
        }
    })

    // Register global shortcut to trigger screen analysis
    globalShortcut.register('CommandOrControl+Shift+S', () => {
        if (win && !win.isDestroyed()) {
            win.webContents.send('trigger-screen-analysis')
        }
    })

    // Register global shortcut for Ghost Mode
    globalShortcut.register('CommandOrControl+Shift+G', () => {
        if (win && !win.isDestroyed()) {
            isGhostMode = !isGhostMode
            // Ignore mouse events but forward them to the OS underneath
            win.setIgnoreMouseEvents(isGhostMode, { forward: true })
            win.webContents.send('ghost-mode-toggled', isGhostMode)
        }
    })

    // Register global shortcuts for moving the window
    const moveStep = 20
    globalShortcut.register('CommandOrControl+Option+Up', () => {
        if (win && !win.isDestroyed()) {
            const [x, y] = win.getPosition()
            win.setPosition(x, y - moveStep)
        }
    })
    globalShortcut.register('CommandOrControl+Option+Down', () => {
        if (win && !win.isDestroyed()) {
            const [x, y] = win.getPosition()
            win.setPosition(x, y + moveStep)
        }
    })
    globalShortcut.register('CommandOrControl+Option+Left', () => {
        if (win && !win.isDestroyed()) {
            const [x, y] = win.getPosition()
            win.setPosition(x - moveStep, y)
        }
    })
    globalShortcut.register('CommandOrControl+Option+Right', () => {
        if (win && !win.isDestroyed()) {
            const [x, y] = win.getPosition()
            win.setPosition(x + moveStep, y)
        }
    })
})

app.on('will-quit', () => {
    globalShortcut.unregisterAll()
})
