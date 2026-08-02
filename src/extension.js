const vscode = require('vscode');
const path = require('path');

function activate(context) {
    const serverPath = path.join(__dirname, 'server.js');
    const serverOptions = {
        command: 'node',
        args: [serverPath],
        options: { env: Object.assign({}, process.env), cwd: path.join(__dirname, '..') },
    };

    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'bob' }],
    };

    try {
        const LC = require('vscode-languageclient/node').LanguageClient;
        const client = new LC('boblang-lsp', 'Boblang Language Server', serverOptions, clientOptions);
        context.subscriptions.push(client.start());
    } catch (e) {
        vscode.window.showErrorMessage('Boblang LSP failed: ' + e.message);
        return;
    }

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.text = "$(symbol-variable) Boblang";
    statusBar.tooltip = "Boblang LSP active";
    statusBar.show();
    context.subscriptions.push(statusBar);
}

function deactivate() { return Promise.resolve(); }
module.exports = { activate, deactivate };
