const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', 'src', 'js');

// Load a browser ES module with every import replaced by the given fakes.
async function loadModule(filename, exportsByImport, globals = {}) {
    const context = vm.createContext({
        console, setTimeout, clearTimeout, AbortController, Promise, Date, JSON,
        ...globals
    });
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    const module = new vm.SourceTextModule(source, { context, identifier: filename });
    await module.link(async specifier => {
        const values = exportsByImport[specifier];
        assert.ok(values, `Unexpected import ${specifier}`);
        return new vm.SyntheticModule(Object.keys(values), function () {
            for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    return module.namespace;
}

module.exports = { loadModule };
