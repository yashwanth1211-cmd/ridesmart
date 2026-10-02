"""Error shape shared by every endpoint.

OWNER: Member 5 (integration).

api_contract.yaml fixes the error body as:

    error_shape: '{ "detail": "human readable", "code": "machine_readable" }'

The first version of these endpoints raised plain HTTPException, which FastAPI
renders as `{"detail": "..."}` only. The machine-readable `code` was being
smuggled through an `X-Code` response header instead, so any client reading the
body - including the frontend - saw a contract violation.

ApiError carries `code` in the body. main.py installs handlers that guarantee the
shape even for validation errors and unhandled HTTPException, so a new endpoint
cannot forget to include it.
"""

from __future__ import annotations

from fastapi import HTTPException

# Fallback codes, used when a handler has nothing more specific to say.
DEFAULT_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    422: "validation_error",
    500: "internal_error",
}


def code_for(status_code: int) -> str:
    return DEFAULT_CODES.get(status_code, "error")


class ApiError(HTTPException):
    """An HTTPException that also returns a machine-readable `code`.

    Subclasses HTTPException so existing `except HTTPException` handling and
    FastAPI's own machinery keep working.
    """

    def __init__(self, status_code: int, detail: str, code: str) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.code = code