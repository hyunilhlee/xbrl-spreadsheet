import AppKit
import Foundation
import WebKit

private struct Scenario {
    let name: String
    let body: String
}

private let harness = #"""
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const cell = (row, col) => {
  const element = document.querySelector(`.cell[data-r="${row}"][data-c="${col}"]`);
  if (!element) throw new Error(`Cell ${row},${col} is not rendered`);
  return element;
};
const center = element => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};
const installCapture = selector => {
  const owner = document.querySelector(selector);
  if (owner.__webkitCaptureStub) return;
  const ids = new Set();
  owner.__webkitCaptureStub = true;
  owner.setPointerCapture = id => ids.add(id);
  owner.hasPointerCapture = id => ids.has(id);
  owner.releasePointerCapture = id => ids.delete(id);
};
const pointer = (type, element, point, buttons = type === 'pointerup' ? 0 : 1) => {
  element.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    clientX: point.x, clientY: point.y,
    pointerId: 71, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons
  }));
};
const press = (element, key) => {
  element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, code: key }));
  element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key, code: key }));
};
const clickCell = async (row, col) => {
  const target = cell(row, col);
  const point = center(target);
  installCapture('#gridCanvas');
  pointer('pointerdown', target, point);
  pointer('pointerup', target, point, 0);
  await wait(30);
};
const setDraft = async (value, caret = value.length, owner = 'cellEditor') => {
  const input = document.getElementById(owner);
  input.value = value;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
  await wait(20);
};
const editCell = async (row, col, value) => {
  await clickCell(row, col);
  press(document, 'F2');
  await wait(25);
  assert(getComputedStyle(document.getElementById('cellEditor')).display !== 'none', 'cell editor did not open');
  await setDraft(value);
  press(document.getElementById('cellEditor'), 'Enter');
  await wait(50);
};
const dragCells = async (fromRow, fromCol, toRow, toCol) => {
  const source = cell(fromRow, fromCol);
  const target = cell(toRow, toCol);
  installCapture('#gridCanvas');
  pointer('pointerdown', source, center(source));
  pointer('pointermove', target, center(target));
  pointer('pointerup', target, center(target), 0);
  await wait(50);
};
const dragFill = async (row, col, release = true) => {
  const handle = document.getElementById('fillHandle');
  assert(getComputedStyle(handle).display !== 'none', 'fill handle is hidden');
  const target = cell(row, col);
  installCapture('#gridCanvas');
  pointer('pointerdown', handle, center(handle));
  pointer('pointermove', target, center(target));
  if (release) pointer('pointerup', target, center(target), 0);
  await wait(90);
  return target;
};
const raw = async (row, col) => {
  await clickCell(row, col);
  return document.getElementById('formulaInput').value;
};
"""#

@main
final class WebKitRegressionRunner: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let scenarios: [Scenario] = [
        Scenario(
            name: "formula cell pick, F4 cycle, Enter, Undo, and Redo",
            body: #"""
await clickCell(1, 1);
press(document, 'F2');
await wait(25);
await setDraft('=');
await clickCell(2, 2);
const editor = document.getElementById('cellEditor');
assert(editor.value === '=C3', `picked draft was ${editor.value}`);
assert(document.getElementById('nameBox').value === 'B2', 'formula origin moved before commit');
const cycle = ['=$C$3', '=C$3', '=$C3', '=C3'];
for (const expected of cycle) {
  press(editor, 'F4');
  await wait(25);
  assert(editor.value === expected, `F4 expected ${expected}, received ${editor.value}`);
}
press(editor, 'Enter');
await wait(60);
assert(await raw(1, 1) === '=C3', 'Enter did not commit the picked reference');
document.getElementById('undoBtn').click();
await wait(50);
assert(await raw(1, 1) === '', 'Undo did not restore the empty cell');
document.getElementById('redoBtn').click();
await wait(50);
assert(await raw(1, 1) === '=C3', 'Redo did not restore the formula');
"""#
        ),
        Scenario(
            name: "formula range pick, exact F4 cycle, and Escape cancellation",
            body: #"""
await clickCell(1, 1);
press(document, 'F2');
await wait(25);
await setDraft('=SUM()', 5);
await dragCells(2, 2, 4, 3);
const editor = document.getElementById('cellEditor');
const cycle = ['=SUM(C3:D5)', '=SUM($C$3:$D$5)', '=SUM(C$3:D$5)', '=SUM($C3:$D5)', '=SUM(C3:D5)'];
assert(editor.value === cycle[0], `range draft was ${editor.value}`);
for (const expected of cycle.slice(1)) {
  press(editor, 'F4');
  await wait(25);
  assert(editor.value === expected, `range F4 expected ${expected}, received ${editor.value}`);
}
press(editor, 'Escape');
await wait(50);
assert(document.getElementById('formulaInput').value === '', 'Escape did not restore the original value');
assert(document.getElementById('undoBtn').disabled, 'cancelled reference created history');
"""#
        ),
        Scenario(
            name: "numeric fill is one exact Undo and Redo action",
            body: #"""
await editCell(0, 2, '1');
await editCell(1, 2, '2');
await dragCells(0, 2, 1, 2);
await dragFill(3, 2);
assert(await raw(2, 2) === '3', 'numeric fill did not generate 3');
assert(await raw(3, 2) === '4', 'numeric fill did not generate 4');
document.getElementById('undoBtn').click();
await wait(50);
assert(await raw(2, 2) === '', 'one Undo did not clear the first destination');
assert(await raw(3, 2) === '', 'one Undo did not clear the second destination');
document.getElementById('redoBtn').click();
await wait(50);
assert(await raw(2, 2) === '3', 'one Redo did not restore the first destination');
assert(await raw(3, 2) === '4', 'one Redo did not restore the second destination');
"""#
        ),
        Scenario(
            name: "formula fill translates relative references",
            body: #"""
await editCell(0, 1, '5');
await editCell(0, 0, '=B1');
await clickCell(0, 0);
await dragFill(2, 0);
assert(await raw(1, 0) === '=B2', 'first filled formula was not translated');
assert(await raw(2, 0) === '=B3', 'second filled formula was not translated');
"""#
        ),
        Scenario(
            name: "Escape cancels an in-progress fill without mutation or history",
            body: #"""
await editCell(0, 2, '1');
await editCell(1, 2, '2');
await dragCells(0, 2, 1, 2);
const target = await dragFill(3, 2, false);
press(document, 'Escape');
await wait(40);
pointer('pointerup', target, center(target), 0);
await wait(50);
assert(await raw(2, 2) === '', 'cancelled fill mutated the first destination');
assert(await raw(3, 2) === '', 'cancelled fill mutated the second destination');
document.getElementById('undoBtn').click();
await wait(50);
assert(await raw(0, 2) === '1', 'cancelled fill added a history action');
assert(await raw(1, 2) === '', 'Undo did not target the last seed edit');
"""#
        )
    ]

    private var window: NSWindow!
    private var webView: WKWebView!
    private var scenarioIndex = 0
    private var scenarioSettled = false
    private var failures: [String] = []
    private var timeout: DispatchWorkItem?
    private var baseURL: URL!

    static func main() {
        let application = NSApplication.shared
        let delegate = WebKitRegressionRunner()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count > 1, let url = URL(string: CommandLine.arguments[1]) else {
            fputs("Usage: webkit-regression <http-url>\n", stderr)
            Foundation.exit(64)
        }
        baseURL = url
        let controller = WKUserContentController()
        controller.add(self, name: "regression")
        controller.addUserScript(WKUserScript(source: #"""
window.__webkitRegressionErrors = [];
// Command-line WKWebView hosts do not receive a display-link callback reliably.
// Preserve animation-frame ordering with a timer so the real app can render and
// interaction reducers can be exercised; stationary-edge timing remains covered
// by the separate Chrome CDP lane.
window.__webkitRegressionRafShim = true;
window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
window.cancelAnimationFrame = identifier => clearTimeout(identifier);
window.addEventListener('error', event => window.__webkitRegressionErrors.push(String(event.error?.stack || event.message || 'window error')));
window.addEventListener('unhandledrejection', event => window.__webkitRegressionErrors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
const originalConsoleError = console.error.bind(console);
console.error = (...args) => { window.__webkitRegressionErrors.push(`console.error: ${args.map(String).join(' ')}`); originalConsoleError(...args); };
"""#, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 900), configuration: configuration)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: webView.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = webView
        window.alphaValue = 1
        window.setFrameOrigin(NSPoint(x: 0, y: 0))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        loadScenario()
    }

    private func loadScenario() {
        timeout?.cancel()
        scenarioSettled = false
        let request = URLRequest(url: baseURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 20)
        webView.load(request)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        waitForBootstrap(remaining: 80)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failCurrent("navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failCurrent("provisional navigation failed: \(error.localizedDescription)")
    }

    private func waitForBootstrap(remaining: Int) {
        webView.evaluateJavaScript("document.readyState === 'complete' && document.querySelectorAll('.cell').length > 0 && performance.getEntriesByType('resource').some(x => x.name.includes('/src/spreadsheet-core.mjs'))") { [weak self] value, error in
            guard let self else { return }
            if error == nil, (value as? Bool) == true {
                self.runCurrentScenario()
            } else if remaining > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.waitForBootstrap(remaining: remaining - 1) }
            } else {
                self.webView.evaluateJavaScript("JSON.stringify({ready:document.readyState,title:document.title,inner:[innerWidth,innerHeight],body:[document.body.clientWidth,document.body.clientHeight],viewport:[document.getElementById('gridViewport')?.clientWidth,document.getElementById('gridViewport')?.clientHeight],canvas:[document.getElementById('gridCanvas')?.style.width,document.getElementById('gridCanvas')?.style.height],tabs:document.querySelectorAll('.sheet-tab').length,cells:document.querySelectorAll('.cell').length,resources:performance.getEntriesByType('resource').map(x=>x.name),errors:window.__webkitRegressionErrors||[]})") { diagnostic, _ in
                    self.failCurrent("app/module bootstrap timed out: \(error?.localizedDescription ?? "readiness predicate false"); diagnostic=\(diagnostic ?? "unavailable")")
                }
            }
        }
    }

    private func runCurrentScenario() {
        let scenario = scenarios[scenarioIndex]
        let script = #"""
(async () => {
  try {
    \#(harness)
    \#(scenario.body)
    const errors = window.__webkitRegressionErrors || [];
    if (errors.length) throw new Error(`runtime failures: ${errors.join(' | ')}`);
    window.webkit.messageHandlers.regression.postMessage({ ok: true, index: \#(scenarioIndex), name: \#(javascriptString(scenario.name)) });
  } catch (error) {
    window.webkit.messageHandlers.regression.postMessage({ ok: false, index: \#(scenarioIndex), name: \#(javascriptString(scenario.name)), error: String(error?.stack || error) });
  }
})();
true;
"""#
        let work = DispatchWorkItem { [weak self] in self?.failCurrent("scenario timed out") }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: work)
        webView.evaluateJavaScript(script) { [weak self] _, error in
            if let error { self?.failCurrent("script injection failed: \(error.localizedDescription)") }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "regression", let payload = message.body as? [String: Any] else { return }
        let receivedIndex = (payload["index"] as? NSNumber)?.intValue ?? -1
        guard receivedIndex == scenarioIndex, !scenarioSettled else { return }
        scenarioSettled = true
        timeout?.cancel()
        let name = payload["name"] as? String ?? scenarios[scenarioIndex].name
        if payload["ok"] as? Bool == true {
            print("PASS \(name)")
        } else {
            let detail = payload["error"] as? String ?? "unknown JavaScript failure"
            failures.append("\(name): \(detail)")
            print("FAIL \(name)\n\(detail)")
        }
        advance()
    }

    private func failCurrent(_ detail: String) {
        guard !scenarioSettled else { return }
        scenarioSettled = true
        timeout?.cancel()
        let name = scenarios[scenarioIndex].name
        failures.append("\(name): \(detail)")
        print("FAIL \(name)\n\(detail)")
        advance()
    }

    private func advance() {
        scenarioIndex += 1
        if scenarioIndex < scenarios.count {
            loadScenario()
            return
        }
        if failures.isEmpty {
            print("\nAll WKWebView engine regressions passed with the documented command-line rAF timer shim (this is not Safari WebDriver evidence).")
            Foundation.exit(0)
        }
        fputs("\n\(failures.count) WKWebView regression(s) failed:\n", stderr)
        for failure in failures { fputs("- \(failure)\n", stderr) }
        Foundation.exit(1)
    }

    private func javascriptString(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        let array = String(data: data, encoding: .utf8)!
        return String(array.dropFirst().dropLast())
    }
}
