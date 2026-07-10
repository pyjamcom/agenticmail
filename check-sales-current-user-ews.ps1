param(
  [string]$Mailbox = "sales@nbr.ru",
  [string]$Server = "ex2.vdostup.ru",
  [string]$WorkspaceRoot = "C:\codex_tools\Purchasing department"
)

$ErrorActionPreference = "Stop"

$python = @'
import os, sys, pathlib, json
root = pathlib.Path(os.environ["WORKSPACE_ROOT"])
sys.path.insert(0, str(root / "services"))
ca = root / "artifacts" / "exchange_tls" / "ad4-ca.pem"
if ca.exists():
    os.environ.setdefault("EXCHANGE_EWS_CA_BUNDLE_PATH", str(ca))
    os.environ.setdefault("REQUESTS_CA_BUNDLE", str(ca))
    os.environ.setdefault("SSL_CERT_FILE", str(ca))

from exchangelib import Account, Configuration, DELEGATE, SSPI
from exchangelib.protocol import BaseProtocol
from requests.adapters import HTTPAdapter

mailbox = os.environ["CHECK_MAILBOX"]
server = os.environ["CHECK_SERVER"]
BaseProtocol.HTTP_ADAPTER_CLS = HTTPAdapter

try:
    config = Configuration(
        service_endpoint=f"https://{server}/EWS/Exchange.asmx",
        credentials=None,
        auth_type=SSPI,
    )
    account = Account(
        primary_smtp_address=mailbox,
        config=config,
        autodiscover=False,
        access_type=DELEGATE,
    )
    folder_count = 0
    for _folder in account.root.walk():
        folder_count += 1
        if folder_count >= 20:
            break
    try:
        inbox_name = account.inbox.name
        inbox_ok = True
        inbox_error_type = None
    except Exception as exc:
        inbox_name = None
        inbox_ok = False
        inbox_error_type = type(exc).__name__
    print(json.dumps({
        "mailbox": mailbox,
        "server": server,
        "current_user_can_open": bool(inbox_ok and folder_count > 0),
        "root_folder_sample_count": folder_count,
        "inbox_ok": inbox_ok,
        "inbox_name": inbox_name,
        "inbox_error_type": inbox_error_type,
    }, ensure_ascii=False, indent=2))
except Exception as exc:
    print(json.dumps({
        "mailbox": mailbox,
        "server": server,
        "current_user_can_open": False,
        "error_type": type(exc).__name__,
        "error": str(exc)[:240],
    }, ensure_ascii=False, indent=2))
'@

$env:WORKSPACE_ROOT = $WorkspaceRoot
$env:CHECK_MAILBOX = $Mailbox
$env:CHECK_SERVER = $Server
$python | python -
