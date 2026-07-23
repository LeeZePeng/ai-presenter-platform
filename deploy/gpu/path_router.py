#!/usr/bin/env python3
"""Expose four loopback workers through one existing public HTTP port.

Requests without a /wN prefix keep targeting worker 0 for backward
compatibility. /w1, /w2 and /w3 select the other GPU workers.
"""

from __future__ import annotations

import argparse
from collections.abc import AsyncIterator

from aiohttp import ClientSession, ClientTimeout, web


HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


def route_request(path_qs: str, worker_ports: list[int]) -> tuple[int, str]:
    path, separator, query = path_qs.partition("?")
    first, slash, remainder = path.lstrip("/").partition("/")
    if len(first) == 2 and first[0] == "w" and first[1].isdigit():
        worker_index = int(first[1])
        if worker_index >= len(worker_ports):
            raise web.HTTPNotFound(text=f"Unknown GPU worker: {first}")
        target_path = f"/{remainder}" if slash else "/"
    else:
        worker_index = 0
        target_path = path or "/"
    if separator:
        target_path = f"{target_path}?{query}"
    return worker_ports[worker_index], target_path


async def body_chunks(request: web.Request) -> AsyncIterator[bytes]:
    async for chunk in request.content.iter_chunked(1024 * 1024):
        yield chunk


async def proxy(request: web.Request) -> web.StreamResponse:
    worker_ports: list[int] = request.app["worker_ports"]
    target_port, target_path = route_request(request.path_qs, worker_ports)
    target_url = f"http://127.0.0.1:{target_port}{target_path}"
    request_headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in HOP_BY_HOP and key.lower() not in {"host", "content-length"}
    }
    session: ClientSession = request.app["session"]
    async with session.request(
        request.method,
        target_url,
        headers=request_headers,
        data=body_chunks(request) if request.can_read_body else None,
        allow_redirects=False,
    ) as upstream:
        response_headers = {
            key: value
            for key, value in upstream.headers.items()
            if key.lower() not in HOP_BY_HOP and key.lower() != "content-length"
        }
        response = web.StreamResponse(status=upstream.status, reason=upstream.reason, headers=response_headers)
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(1024 * 1024):
            await response.write(chunk)
        await response.write_eof()
        return response


async def create_session(app: web.Application) -> None:
    app["session"] = ClientSession(timeout=ClientTimeout(total=None, connect=30, sock_read=None))


async def close_session(app: web.Application) -> None:
    await app["session"].close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen", default="0.0.0.0")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--worker-ports", type=int, nargs="+", required=True)
    args = parser.parse_args()
    app = web.Application(client_max_size=1024**4)
    app["worker_ports"] = args.worker_ports
    app.on_startup.append(create_session)
    app.on_cleanup.append(close_session)
    app.router.add_route("*", "/{path:.*}", proxy)
    web.run_app(app, host=args.listen, port=args.port, access_log=None)


if __name__ == "__main__":
    main()
