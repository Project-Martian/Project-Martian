"""Offline boundary tests. Bedrock is stubbed; MCP calls use the real protocol."""
import unittest
import logging
logging.disable(logging.CRITICAL)
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from mcp import Client

from server import assistant
from server.app import app
from server.mcp_records import BY_ID, RECORDS, mcp
from server.models import AskInput, FinalAnswer, RecordSelection, RequestPlan, ReviewDecision

RECORD = 'us-government-website-activity'
BOUNDS = {'scope': 'agents', 'start_date': '2026-09-21', 'end_date': '2026-09-27'}


def final(**overrides):
    value = {'status': 'answered', 'answer_kind': 'listing', 'intro': 'Agent incidents in the requested week.',
             'record_ids': [RECORD], 'sections': []}
    value.update(overrides)
    return value


class McpTests(unittest.IsolatedAsyncioTestCase):
    async def test_tools_are_read_only_and_complete(self):
        async with Client(mcp) as client:
            tools = (await client.list_tools()).tools
            self.assertEqual({t.name for t in tools}, {'get_archive_context', 'list_incidents', 'get_incident_details'})
            self.assertTrue(all(t.annotations.read_only_hint and not t.annotations.open_world_hint for t in tools))
            context = (await client.call_tool('get_archive_context', {})).structured_content
            self.assertEqual({r['id'] for r in context['record_index']}, set(BY_ID))
            result = (await client.call_tool('list_incidents', dict(BOUNDS, start_date='', end_date='', scope='all'))).structured_content
            self.assertTrue(result['complete'])
            self.assertEqual({r['id'] for r in result['records']}, set(BY_ID))

    async def test_explicit_date_windows_and_scope(self):
        async with Client(mcp) as client:
            for start, end, expected in [('2026-09-28', '2026-10-01', []),
                                         ('2026-09-21', '2026-09-27', [RECORD])]:
                result = (await client.call_tool('list_incidents', dict(BOUNDS, start_date=start, end_date=end))).structured_content
                self.assertEqual([r['id'] for r in result['records']], expected)
            result = (await client.call_tool('list_incidents', dict(BOUNDS, start_date='', end_date=''))).structured_content
            self.assertEqual({r['id'] for r in result['records']}, {r['id'] for r in RECORDS if r['scope'] == 'agents'})

    async def test_bad_dates_and_unknown_ids_are_errors(self):
        async with Client(mcp) as client:
            for name, args in [('list_incidents', dict(BOUNDS, start_date='yesterday')),
                               ('list_incidents', dict(BOUNDS, start_date='2026-10-02')),
                               ('get_incident_details', {'record_ids': ['made-up']}),
                               ('get_incident_details', {'record_ids': [RECORD, RECORD]})]:
                result = await client.call_tool(name, args)
                self.assertTrue(result.is_error)


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def run_agent(self, selection=None, review='allow', plan=None, body=None):
        plan = plan or RequestPlan(**BOUNDS, interpretation='Agent incidents last week',
            decision='allow', answer_kind='listing', clarification='')
        selection = selection or RecordSelection(selection_mode='selected_ids', record_ids=[RECORD])
        responses = [plan, selection, ReviewDecision(reason='Evidence checked', decision=review)]
        with patch.object(assistant, 'model_json', AsyncMock(side_effect=responses)) as model:
            result = await assistant.answer_question(body or AskInput(question='Who went bad last week?'))
            return result, model

    async def test_model_selected_window_uses_real_mcp_and_cited_answer(self):
        result, model = await self.run_agent()
        self.assertEqual(result['record_ids'], [RECORD])
        self.assertIn(BY_ID[RECORD]['limits'], result['text'])
        self.assertEqual(model.call_count, 3)
        self.assertEqual(model.call_args_list[1].args[1]['catalogs'][0]['filters'], BOUNDS)
        self.assertIn(RECORD, result['context_turn']['record_ids'])

    async def test_whole_catalog_expansion_preserves_every_id(self):
        plan = RequestPlan(scope='all', start_date='', end_date='', interpretation='Entire archive',
                           decision='allow', answer_kind='listing')
        result, _ = await self.run_agent(plan=plan,
            selection=RecordSelection(selection_mode='all_catalog', record_ids=[]))
        self.assertEqual(set(result['record_ids']), set(BY_ID))
        self.assertEqual(result['matching_records'], len(RECORDS))

    def test_missing_dates_never_widen_an_accepted_request(self):
        with self.assertRaises(ValueError):
            RequestPlan(decision='allow', answer_kind='listing', scope='agents')
        self.assertEqual(RequestPlan(decision='reject').decision, 'reject')

    def test_strict_wire_schema_requires_fields_and_keeps_local_limits(self):
        schema = assistant.output_schema(RequestPlan)
        self.assertEqual(set(schema['required']), set(schema['properties']))
        self.assertFalse(schema['additionalProperties'])
        self.assertNotIn('maxLength', schema['properties']['interpretation'])
        self.assertTrue(assistant.spec('return_result', 'Result', schema)['toolSpec']['strict'])
        with self.assertRaises(ValueError):
            RequestPlan(decision='reject', interpretation='x' * 901)
        nested = assistant.output_schema(FinalAnswer)['properties']['sections']['items']
        self.assertEqual(set(nested['required']), set(nested['properties']))
        self.assertNotIn('maxItems', nested['properties']['record_ids'])

    async def test_scope_rejection_never_reads_full_evidence(self):
        plan = RequestPlan(**BOUNDS, interpretation='Unrelated task', decision='reject',
                           answer_kind='listing', clarification='')
        with patch.object(assistant, 'model_json', AsyncMock(return_value=plan)) as model, \
             patch.object(assistant, 'call_tool', wraps=assistant.call_tool) as tools:
            result = await assistant.answer_question(AskInput(question='Write a recipe'))
            self.assertEqual(result['status'], 'rejected')
            self.assertEqual(model.call_count, 1)
            self.assertEqual([c.args[2] for c in tools.call_args_list], ['get_archive_context'])

    async def test_unlisted_tool_or_extra_arguments_cannot_run(self):
        async with Client(mcp) as client:
            schemas = {t.name: dict(t.input_schema, additionalProperties=False) for t in (await client.list_tools()).tools}
            for name, args in [('run_command', {}), ('list_incidents', dict(BOUNDS, date_from='2026-09-28'))]:
                with self.assertRaises(ValueError):
                    await assistant.call_tool(client, schemas, name, args)

    async def test_selection_cannot_read_ids_outside_returned_window(self):
        for ids in [['invented'], ['hugging-face-intrusion'], [RECORD, RECORD]]:
            with self.assertRaises(ValueError):
                await self.run_agent(selection=RecordSelection(selection_mode='selected_ids', record_ids=ids))

    async def test_no_matches_preserves_period_and_history(self):
        plan = RequestPlan(scope='agents', start_date='2026-09-28', end_date='2026-10-01',
                           interpretation='Agent incidents this week', decision='allow',
                           answer_kind='listing', clarification='')
        result, model = await self.run_agent(plan=plan, selection=RecordSelection(selection_mode='selected_ids', record_ids=[]))
        self.assertEqual(result['status'], 'no_matches')
        self.assertIn('2026-09-28', result['context_turn']['answer'])
        body = AskInput.model_validate({'question': 'What about last week?', 'history': [result['context_turn']]})
        _, model = await self.run_agent(body=body)
        self.assertEqual(model.call_args_list[0].args[1]['history'], [result['context_turn']])

    async def test_review_failure_fails_closed_without_retry(self):
        with self.assertRaises(ValueError):
            await self.run_agent(review='reject')

    async def test_expired_budget_never_calls_bedrock(self):
        with patch.object(assistant, 'bedrock') as aws:
            with self.assertRaises(ValueError):
                await assistant.converse('', [], [], 100, 0)
            aws.assert_not_called()

    def test_citations_and_format_boundaries(self):
        for answer in [final(intro='<b>test</b>'), final(record_ids=[RECORD, RECORD]),
                       final(answer_kind='explanation', sections=[{'heading': 'Impact', 'text': 'Example', 'record_ids': ['unknown']}])]:
            with self.assertRaises(ValueError):
                assistant.validate_answer(FinalAnswer.model_validate(answer), [], {RECORD: BY_ID[RECORD]})
        with self.assertRaises(ValueError):
            assistant.validate_answer(FinalAnswer.model_validate(final()), [], {})
        with self.assertRaises(ValueError):
            assistant.validate_answer(FinalAnswer.model_validate(final(status='no_matches', record_ids=[])), [], {})


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url='http://localhost')

    def test_validation_and_private_routes_without_inference(self):
        with patch('server.app.answer_question', AsyncMock()) as model:
            self.assertEqual(self.client.post('/api/ask', json={'question': '  '}).status_code, 400)
            self.assertEqual(self.client.post('/api/ask', json={'question': 'x', 'history': [{}]*7}).status_code, 400)
            self.assertEqual(self.client.post('/api/ask', content='{}').status_code, 415)
            self.assertEqual(self.client.post('/api/ask', json={'question': 'x'}, headers={'Origin': 'https://elsewhere.example'}).status_code, 403)
            self.assertEqual(self.client.post('/api/ask', content=' '*65537, headers={'Content-Type': 'application/json'}).status_code, 413)
            for path in ['/server/assistant.py', '/.env', '/mcp', '/requirements.txt']:
                self.assertEqual(self.client.get(path).status_code, 404)
            model.assert_not_called()

    def test_failed_response_releases_capacity(self):
        with patch('server.app.answer_question', AsyncMock(side_effect=[ValueError('Invalid output'), {'status': 'rejected'}])):
            self.assertEqual(self.client.post('/api/ask', json={'question': 'x'}).status_code, 502)
            self.assertEqual(self.client.post('/api/ask', json={'question': 'x'}).status_code, 200)


if __name__ == '__main__':
    unittest.main()
