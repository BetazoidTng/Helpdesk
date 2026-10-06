// Turns a control event received from the support agent's browser (over
// the WebRTC data channel, relayed here by main.js) into an actual mouse
// move/click/scroll or key press on this computer, using nut.js -- the
// only part of this app that needs real OS-level input-injection
// permissions (see README.md: on macOS this means granting Accessibility
// access to the app; on Windows it generally just works; on Linux it
// depends on your display server, see the README).
//
// Deliberately kept as its own module, required only from main.js (the
// Electron *main* process) -- nut.js needs native bindings that have no
// business running inside the renderer that's also showing arbitrary
// remote video, so control events cross from renderer to main over IPC
// (see preload.js) before ever reaching this file.
let nut = null;
function loadNut() {
    if (!nut) nut = require('@nut-tree-fork/nut-js');
    return nut;
}

// Maps a DOM KeyboardEvent.code (e.what the browser-side viewer sends --
// see public/remote-assist.html) to nut.js's Key enum. Not exhaustive --
// anything not listed here is silently ignored rather than throwing, so
// one unmapped key never breaks the rest of a session.
function buildKeyMap() {
    const { Key } = loadNut();
    const map = {};
    for (let i = 0; i < 26; i++) {
        const letter = String.fromCharCode(65 + i); // A-Z
        map[`Key${letter}`] = Key[letter];
    }
    for (let i = 0; i <= 9; i++) {
        map[`Digit${i}`] = Key[`Num${i}`];
    }
    for (let i = 1; i <= 12; i++) {
        map[`F${i}`] = Key[`F${i}`];
    }
    Object.assign(map, {
        Enter: Key.Enter, NumpadEnter: Key.Enter, Escape: Key.Escape, Backspace: Key.Backspace,
        Tab: Key.Tab, Space: Key.Space, Delete: Key.Delete, Insert: Key.Insert,
        Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown,
        ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
        ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
        ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
        AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
        MetaLeft: Key.LeftSuper, MetaRight: Key.RightSuper,
        CapsLock: Key.CapsLock,
        Minus: Key.Minus, Equal: Key.Equal, BracketLeft: Key.LeftBracket, BracketRight: Key.RightBracket,
        Semicolon: Key.Semicolon, Quote: Key.Quote, Backslash: Key.Backslash,
        Comma: Key.Comma, Period: Key.Period, Slash: Key.Slash, Backquote: Key.Grave,
    });
    return map;
}

let keyMap = null;
function keyFor(code) {
    if (!keyMap) keyMap = buildKeyMap();
    return keyMap[code];
}

function buttonFor(domButton) {
    const { Button } = loadNut();
    if (domButton === 1) return Button.MIDDLE;
    if (domButton === 2) return Button.RIGHT;
    return Button.LEFT;
}

// One queue, processed strictly in order -- mouse/keyboard input is
// inherently sequential (a mousedown must land before the mouseup that
// follows it), so events are awaited one at a time rather than fired off
// in parallel as they arrive.
let queue = Promise.resolve();

function handle(event) {
    queue = queue.then(() => applyEvent(event)).catch((err) => {
        console.error('Failed to apply remote control event:', event && event.type, err.message);
    });
    return queue;
}

async function applyEvent(event) {
    const { mouse, keyboard, Point } = loadNut();
    switch (event.type) {
        case 'mousemove':
            await mouse.setPosition(new Point(event.x, event.y));
            break;
        case 'mousedown':
            await mouse.setPosition(new Point(event.x, event.y));
            await mouse.pressButton(buttonFor(event.button));
            break;
        case 'mouseup':
            await mouse.setPosition(new Point(event.x, event.y));
            await mouse.releaseButton(buttonFor(event.button));
            break;
        case 'scroll': {
            const amount = Math.max(1, Math.round(Math.abs(event.deltaY || 0) / 4));
            if (event.deltaY > 0) await mouse.scrollDown(amount);
            else if (event.deltaY < 0) await mouse.scrollUp(amount);
            break;
        }
        case 'keydown': {
            const key = keyFor(event.code);
            if (key !== undefined) await keyboard.pressKey(key);
            break;
        }
        case 'keyup': {
            const key = keyFor(event.code);
            if (key !== undefined) await keyboard.releaseKey(key);
            break;
        }
        default:
            // Unknown event type -- ignore rather than throw, so a
            // version mismatch between the viewer and this agent never
            // takes the whole session down.
            break;
    }
}

module.exports = { handle };
