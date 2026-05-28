"""Async SQLAlchemy 엔진 + 세션 — Aurora PostgreSQL.

문서: §5.4
환경변수: DATABASE_URL (예: postgresql+asyncpg://user:pwd@host:5432/soopulai)

또한 raw asyncpg pool 을 노출 — SQLAlchemy ORM 이 lazy load 시 MissingGreenlet 을 일으키는
회피 경로용. sessions.py 의 핵심 endpoint 가 이걸 직접 사용.
"""

from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from typing import AsyncIterator

import asyncpg
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool


def _database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if not url:
        # 개발 fallback — sqlite (인-메모리 안 되는 모델은 구조만 검증)
        url = "sqlite+aiosqlite:///./soopulai_dev.db"
    return url


_engine = None
_SessionLocal = None


def get_engine():
    global _engine
    if _engine is None:
        # NullPool: 매 요청마다 새 connection 생성. asyncpg 의 cross-loop binding 으로
        # 인한 MissingGreenlet 회피. Aurora 라 connection cost 가 낮음.
        _engine = create_async_engine(
            _database_url(),
            echo=False,
            future=True,
            poolclass=NullPool,
        )
    return _engine


def get_sessionmaker():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = async_sessionmaker(get_engine(), expire_on_commit=False, class_=AsyncSession)
    return _SessionLocal


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """프레임워크 외부 코드 (Lambda 등) 가 세션을 쓸 때."""
    SessionLocal = get_sessionmaker()
    async with SessionLocal() as s:
        try:
            yield s
            await s.commit()
        except Exception:
            await s.rollback()
            raise


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI Depends 용 — app/deps.py 에서 re-export."""
    SessionLocal = get_sessionmaker()
    async with SessionLocal() as s:
        try:
            yield s
        finally:
            await s.close()


# ─────────────────────────────────────────────────────────────────────
# Raw asyncpg pool — ORM lazy-load 회피용. sessions.py 가 이걸 사용.
# DATABASE_URL 의 sqlalchemy URL 을 asyncpg DSN 으로 변환:
#   postgresql+asyncpg://user:pwd@host:5432/db?ssl=require
#   → postgresql://user:pwd@host:5432/db   (asyncpg 는 ssl 을 인자로 받음)
# ─────────────────────────────────────────────────────────────────────
_pg_pool: asyncpg.Pool | None = None


def _asyncpg_dsn() -> tuple[str, dict]:
    url = _database_url()
    # sqlite fallback 이면 raw pool 미사용 (sqlite 는 ORM only)
    if url.startswith("sqlite"):
        raise RuntimeError("raw asyncpg pool requires PostgreSQL DATABASE_URL")
    # driver suffix 제거
    dsn = re.sub(r"^postgresql\+\w+://", "postgresql://", url)
    # query string 에서 ssl 옵션 추출 → asyncpg 의 ssl mode string 으로 전달
    ssl_arg: str | bool = False
    m = re.search(r"[?&]ssl=([^&]+)", dsn)
    if m:
        v = m.group(1).lower()
        # 'require' 는 verify 안 함 — Aurora 의 RDS CA 가 시스템 trust store 에 없을 때 안전.
        # verify 필요하면 'verify-ca' / 'verify-full' 사용 (RDS root CA 설치 후).
        ssl_arg = "require" if v in ("require", "true", "1") else v
        dsn = re.sub(r"[?&]ssl=[^&]+", "", dsn)
    # sslmode 도 처리 (libpq 표기)
    m2 = re.search(r"[?&]sslmode=([^&]+)", dsn)
    if m2:
        ssl_arg = m2.group(1).lower()
        dsn = re.sub(r"[?&]sslmode=[^&]+", "", dsn)
    dsn = re.sub(r"\?$|&$", "", dsn).replace("?&", "?")
    return dsn, {"ssl": ssl_arg} if ssl_arg else {}


async def get_pg_pool() -> asyncpg.Pool:
    """asyncpg connection pool (global, lazy)."""
    global _pg_pool
    if _pg_pool is None:
        dsn, kw = _asyncpg_dsn()
        _pg_pool = await asyncpg.create_pool(
            dsn,
            min_size=1,
            max_size=10,
            server_settings={"search_path": "soopulai"},
            **kw,
        )
    return _pg_pool


@asynccontextmanager
async def pg_conn():
    """raw asyncpg connection (with search_path=soopulai)."""
    pool = await get_pg_pool()
    async with pool.acquire() as conn:
        yield conn


async def get_pg() -> AsyncIterator[asyncpg.Connection]:
    """FastAPI Depends 용 raw asyncpg connection."""
    async with pg_conn() as c:
        yield c
