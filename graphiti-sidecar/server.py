#!/usr/bin/env python3
"""Small local HTTP adapter for graphiti-core.

Graph database and LLM credentials are configured through environment variables.
The adapter is intentionally narrow so Mirai can fall back when it is unavailable.
"""
import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

_graphiti = None
_init_lock = None
_event_loop = None
_loop_thread = None
_init_state = 'idle'
_init_error = None


def load_dotenv():
    dotenv = Path(__file__).resolve().parent.parent / '.env'
    if not dotenv.exists():
        return
    for raw in dotenv.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def env(name, default=''):
    return os.environ.get(name, default).strip()


def create_ollama_client(config):
    """Create a Graphiti client that disables Ollama thinking for JSON extraction."""
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient

    class Client(OpenAIGenericClient):
        async def _generate_response(self, messages, response_model=None, max_tokens=8192, model_size=None):
            openai_messages = []
            for message in messages:
                message.content = self._clean_input(message.content)
                if message.role in ('user', 'system'):
                    openai_messages.append({'role': message.role, 'content': message.content})
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=openai_messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                response_format={'type': 'json_object'},
                extra_body={'think': False},
            )
            return json.loads(response.choices[0].message.content or '')

    return Client(config=config)


async def get_graphiti():
    global _graphiti, _init_lock, _init_state, _init_error
    if _graphiti is not None:
        return _graphiti
    if _init_lock is None:
        _init_lock = asyncio.Lock()
    async with _init_lock:
        if _graphiti is not None:
            return _graphiti
        _init_state = 'initializing'
        _init_error = None
        from graphiti_core import Graphiti
        from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
        from graphiti_core.driver.neo4j_driver import Neo4jDriver
        from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
        from graphiti_core.llm_client import LLMConfig
        from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
        driver = Neo4jDriver(
            uri=env('GRAPHITI_NEO4J_URI', 'bolt://127.0.0.1:7687'),
            user=env('GRAPHITI_NEO4J_USER', 'neo4j'),
            password=env('GRAPHITI_NEO4J_PASSWORD'),
            database=env('GRAPHITI_NEO4J_DATABASE', 'neo4j'),
        )
        llm_config = LLMConfig(
            api_key=env('GRAPHITI_LLM_API_KEY', 'none'),
            model=env('GRAPHITI_LLM_MODEL'),
            small_model=env('GRAPHITI_LLM_SMALL_MODEL') or None,
            base_url=env('GRAPHITI_LLM_BASE_URL') or None,
            temperature=0,
            max_tokens=int(env('GRAPHITI_LLM_MAX_TOKENS', '2048')),
        )
        # graphiti-core 0.18.x uses JSON-capable OpenAI-compatible calls internally;
        # structured output mode is not a constructor argument in this API.
        llm_client = OpenAIGenericClient(config=llm_config)
        if env('GRAPHITI_OLLAMA_THINK', 'false').lower() in ('0', 'false', 'no', 'off') and '127.0.0.1:11434' in (llm_config.base_url or ''):
            llm_client = create_ollama_client(llm_config)
        embedder = OpenAIEmbedder(OpenAIEmbedderConfig(
            api_key=env('GRAPHITI_EMBED_API_KEY', env('GRAPHITI_LLM_API_KEY', 'none')),
            base_url=env('GRAPHITI_EMBED_BASE_URL') or env('GRAPHITI_LLM_BASE_URL') or None,
            embedding_model=env('GRAPHITI_EMBED_MODEL'),
        ))
        _graphiti = Graphiti(
            graph_driver=driver,
            llm_client=llm_client,
            embedder=embedder,
            cross_encoder=OpenAIRerankerClient(config=llm_config),
        )
        try:
            await _graphiti.build_indices_and_constraints()
        except Exception as error:
            _graphiti = None
            _init_state = 'error'
            _init_error = str(error)[:500]
            raise
        _init_state = 'ready'
    return _graphiti


def parse_time(value):
    if not value:
        return datetime.now(timezone.utc)
    return datetime.fromisoformat(str(value).replace('Z', '+00:00'))


def start_event_loop():
    global _event_loop, _loop_thread
    _event_loop = asyncio.new_event_loop()

    def loop_runner():
        asyncio.set_event_loop(_event_loop)
        _event_loop.run_forever()

    _loop_thread = Thread(target=loop_runner, name='graphiti-asyncio', daemon=True)
    _loop_thread.start()


def run(coro):
    if _event_loop is None:
        raise RuntimeError('Graphiti event loop is not running')
    future = asyncio.run_coroutine_threadsafe(coro, _event_loop)
    return future.result()


async def add_episode(payload):
    graph = await get_graphiti()
    messages = payload.get('messages') or []
    body = '\n'.join(('主人' if m.get('role') == 'user' else '小未来') + '：' + str(m.get('content', '')) for m in messages)
    if not body.strip():
        return {'ok': False, 'error': 'empty episode'}
    await asyncio.wait_for(graph.add_episode(
        name='mirai-chat',
        episode_body=body[:12000],
        source_description='Mirai desktop companion conversation',
        reference_time=parse_time(payload.get('reference_time')),
        group_id=str(payload.get('group_id') or 'mirai-owner'),
    ), timeout=float(env('GRAPHITI_EPISODE_TIMEOUT', '120')))
    return {'ok': True}


async def search(payload):
    graph = await get_graphiti()
    edges = await asyncio.wait_for(graph.search(
        query=str(payload.get('query') or '')[:2000],
        group_ids=[str(payload.get('group_id') or 'mirai-owner')],
    ), timeout=float(env('GRAPHITI_SEARCH_TIMEOUT', '30')))
    results = []
    for edge in edges[:8]:
        results.append({
            'fact': getattr(edge, 'fact', '') or '',
            'valid_at': getattr(edge, 'valid_at', None).isoformat() if getattr(edge, 'valid_at', None) else None,
            'invalid_at': getattr(edge, 'invalid_at', None).isoformat() if getattr(edge, 'invalid_at', None) else None,
            'created_at': getattr(edge, 'created_at', None).isoformat() if getattr(edge, 'created_at', None) else None,
        })
    return {'results': results}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('[Graphiti sidecar] ' + (fmt % args))

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except BrokenPipeError:
            # The Electron client may time out while a long LLM extraction is running.
            pass

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {
                'ok': _init_state == 'ready',
                'graphiti': bool(_graphiti),
                'state': _init_state,
                **({'error': _init_error} if _init_error else {}),
            })
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path not in ('/episode', '/search'):
            self.send_json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            payload = json.loads(self.rfile.read(length) or '{}')
            result = run(add_episode(payload) if self.path == '/episode' else search(payload))
            self.send_json(200, result)
        except Exception as exc:
            global _init_state, _init_error
            if _init_state == 'initializing':
                _init_state = 'error'
                _init_error = str(exc)[:500]
            print(f'[Graphiti sidecar] request failed: {exc}')
            try:
                self.send_json(503, {'ok': False, 'error': str(exc)[:500]})
            except BrokenPipeError:
                pass


if __name__ == '__main__':
    load_dotenv()
    host = env('GRAPHITI_HOST', '127.0.0.1')
    port = int(env('GRAPHITI_PORT', '8766'))
    start_event_loop()
    print(f'[Graphiti sidecar] listening on http://{host}:{port}')
    try:
        ThreadingHTTPServer((host, port), Handler).serve_forever()
    finally:
        if _event_loop is not None:
            _event_loop.call_soon_threadsafe(_event_loop.stop)
        if _loop_thread is not None:
            _loop_thread.join(timeout=5)
