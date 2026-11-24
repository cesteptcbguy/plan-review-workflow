const assert = require('node:assert/strict');
const test = require('node:test');
const { parseClaudeModelCatalog, parseModelServicePage } = require('../dist/model-discovery.js');

test('reads only models authorized by the Codex app-server catalog', () => {
  const service = parseModelServicePage([{
    model: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]
  }]);
  assert.deepEqual(service.map(model => model.id), ['gpt-6-astra']);
  assert.equal(service[0].displayName, 'GPT-6-Astra');
  assert.equal(service[0].isDefault, true);
  assert.deepEqual(service[0].supportedReasoningEfforts, ['low', 'high']);
});

test('reads versioned Claude Code models and their effort levels', () => {
  const models = parseClaudeModelCatalog(JSON.stringify({ catalog: { config: { models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', short_name: 'Opus', section: 'main', runtime: { family: 'opus', default_effort: 'medium', effort_levels: ['low', 'high'] } },
    { id: 'claude-opus-5', name: 'Opus 5', short_name: 'Opus', section: 'overflow', runtime: { family: 'opus', effort_levels: ['low'] } }
  ] } } }));

  assert.deepEqual(models.map(model => model.id), ['claude-opus-5-5', 'claude-opus-5']);
  assert.equal(models[0].name, 'Opus 5.5');
  assert.equal(models[0].defaultEffort, 'medium');
  assert.deepEqual(models[0].supportedEfforts, ['low', 'high']);
});
