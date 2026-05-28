"""app/services/ · 외부 의존성 wrapper.

- stepfunctions.py · AWS Step Functions StartExecution
- hapi_client.py   · HAPI FHIR REST 호출
- audit_log.py     · 의료 데이터 접근 기록
- ws_connections.py · WebSocket connection manager (EMR updates)
- poller_mock.py   · 시연용 mock 이벤트 emitter
- poller_fhir.py   · 실제 FHIR ?_lastUpdated 폴링
"""
