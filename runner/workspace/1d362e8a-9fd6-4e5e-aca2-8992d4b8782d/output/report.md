# AlphaSift Local Test Report

## Verified

- Editable package installation completed with `python -m pip install -e ".[dev]"` in a repository-local `.venv`.
- CLI help completed: `alphasift --help`.
- Full test suite completed: `python -m pytest --basetemp C:\Users\1\AppData\Local\Temp\opencode\alphasift-pytest-basetemp` with `302 passed, 1 skipped in 3.48s`.
- Strategy catalog and project audit completed: `alphasift strategies` and `alphasift audit`; ten built-in strategies were listed.
- Offline hotspot path completed: `alphasift hotspots --provider none --explain`, reporting `hotspots=0 provider=none schema_version=2`.
- No-key quickstart completed: `alphasift quickstart`; it fetched a Sina snapshot with 5529 rows and returned five `dual_low` picks.
- Deterministic Python API call completed: `screen("dual_low", use_llm=False)` returned a `ScreenResult` with five picks.

## Execution Notes

- `ALPHASIFT_DATA_DIR` was set to an isolated temporary test-data directory for runtime checks.
- The initial plain pytest invocation encountered sandbox permission errors while accessing the default `pytest-of-1` temporary directory. Re-running with an explicit writable `--basetemp` passed the complete suite.
- Command logs are retained under `C:\Users\1\AppData\Local\Temp\opencode\alphasift-test-logs`.

## Not Covered

- LLM ranking was not enabled because no provider credentials were supplied.
- DSA post-analysis was not tested because `DSA_API_URL` was not configured.
- Live third-party market, daily K-line, and hotspot providers were not validated beyond the quickstart snapshot retrieval.
- `alphasift serve` was not started because this task did not require HTTP acceptance.

## Changes

- No repository source changes were made.
