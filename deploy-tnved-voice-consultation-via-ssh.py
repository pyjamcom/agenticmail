from __future__ import annotations

import argparse
import base64
import hashlib
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import paramiko


ROOT = Path(__file__).resolve().parent
VOICE_FILES = (
    "sip-sidecar.mjs",
    "sales-call-scenario.json",
    "README.md",
    "nbr-service-rates.json",
)
SIDECAR_ROOT = ROOT / "sip-sidecar"


def credentials(path: Path) -> tuple[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        values[key.strip().lower()] = value.strip()
    username = values.get("log", "")
    password = values.get("pass", "")
    if not username or not password:
        raise RuntimeError("Credential file must contain log: and pass: entries")
    return username, password


def ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def encoded_powershell(script: str) -> str:
    payload = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    return f"powershell.exe -NoProfile -NonInteractive -EncodedCommand {payload}"


def run_powershell(
    client: paramiko.SSHClient,
    script: str,
    *,
    timeout: int = 180,
) -> str:
    _, stdout, stderr = client.exec_command(
        encoded_powershell(script),
        timeout=timeout,
    )
    output = stdout.read().decode("utf-8", errors="replace").strip()
    diagnostic = stderr.read().decode("utf-8", errors="replace").strip()
    exit_code = stdout.channel.recv_exit_status()
    if exit_code != 0:
        safe_diagnostic = diagnostic.encode("unicode_escape").decode("ascii")[:1_000]
        raise RuntimeError(
            f"Remote PowerShell failed with exit code {exit_code}; "
            f"stderr_present={bool(diagnostic)}; diagnostic={safe_diagnostic}"
        )
    return output


def sftp_path(path: str) -> str:
    return path.replace("\\", "/")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def json_from_output(output: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise RuntimeError("Remote command returned no JSON object")


def deploy(
    *,
    host: str,
    credential_path: Path,
    remote_agenticmail_root: str,
) -> dict[str, Any]:
    username, password = credentials(credential_path)
    scenario = json.loads(
        (SIDECAR_ROOT / "sales-call-scenario.json").read_text(encoding="utf-8")
    )
    expected_version = int(scenario["version"])
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stage_root = rf"C:\ProgramData\NevskyBroker\Deploy\customs-voice-{stamp}"
    remote_sidecar_root = remote_agenticmail_root + r"\sip-sidecar"
    remote_deploy_script = stage_root + r"\deploy.ps1"
    remote_verify_script = stage_root + r"\verify.ps1"
    report_path = stage_root + r"\verification.json"
    canonical_report = (
        rf"C:\ProgramData\NevskyBroker\Audits"
        rf"\customs-voice-v{expected_version}-verification.json"
    )
    local_files = {
        name: SIDECAR_ROOT / name
        for name in VOICE_FILES
    }
    local_files["deploy.ps1"] = ROOT / "deploy-tnved-voice-consultation-remote.ps1"
    local_files["verify.ps1"] = ROOT / "verify-tnved-voice-stack-remote.ps1"
    hashes = {name: sha256(path) for name, path in local_files.items()}

    product_card = {
        "name": "самоклеящаяся пленка ПЭТ",
        "purpose": "изготовление этикеток",
        "composition": "полиэфирная пленка с акриловым клеем",
        "processing_stage": "готовая пленка",
        "technical_params": (
            "ширина 500 миллиметров; толщина 50 микрометров; "
            "самоклеящаяся"
        ),
        "packaging_or_form": "в рулонах",
        "country_context": "Китай; ввоз в Россию",
    }
    product_card_base64 = base64.b64encode(
        json.dumps(product_card, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    copied = False
    try:
        client.connect(
            hostname=host,
            username=username,
            password=password,
            timeout=15,
            auth_timeout=15,
            banner_timeout=15,
            look_for_keys=False,
            allow_agent=False,
        )
        preflight_output = run_powershell(
            client,
            "\n".join(
                [
                    "$ErrorActionPreference='Stop'",
                    "$health=Invoke-RestMethod 'http://127.0.0.1:3899/health' -TimeoutSec 10",
                    "if([int]$health.activeCalls-gt 0){throw 'Refusing deployment while a call is active'}",
                    "$taskNames=@('AgenticMail-SIP-Sidecar-Service','AgenticMail-SIP-Sidecar-Watchdog')",
                    "$tasks=@($taskNames|ForEach-Object{",
                    "$task=Get-ScheduledTask -TaskName $_ -ErrorAction Stop",
                    "$sid=([Security.Principal.NTAccount]$task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value",
                    "if($sid-ne'S-1-5-18'){throw \"$_ must run as SYSTEM\"}",
                    "[ordered]@{name=$_;sid=$sid;state=[string]$task.State}})",
                    "$tnved=Invoke-RestMethod 'http://10.0.200.101:8100/tnved/health' -TimeoutSec 20",
                    "if($tnved.status-ne'ok'-or$tnved.preflight.ok-ne$true-or$tnved.vehicle_customs.ready-ne$true){throw 'TNVED API is not ready'}",
                    f"New-Item -ItemType Directory -Path {ps_quote(stage_root)} -Force|Out-Null",
                    "[ordered]@{status='ok';activeCalls=[int]$health.activeCalls;registered=[bool]$health.registered;scenarioVersion=[int]$health.salesScenario.version;tasks=$tasks;tnvedKb=[string]$tnved.preflight.kb_version;retrievalNoiseRatio=[double]$tnved.preflight.retrieval_noise_ratio}|ConvertTo-Json -Depth 6 -Compress",
                ]
            ),
        )
        preflight = json_from_output(preflight_output)

        sftp = client.open_sftp()
        try:
            for name, local_path in local_files.items():
                with local_path.open("rb") as source:
                    with sftp.open(sftp_path(stage_root + "\\" + name), "wb") as target:
                        target.write(source.read())
        finally:
            sftp.close()

        copied = True
        deploy_output = run_powershell(
            client,
            "Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; " + " ".join(
                [
                    f"& {ps_quote(remote_deploy_script)}",
                    f"-StagePath {ps_quote(stage_root)}",
                    f"-Stamp {ps_quote(stamp)}",
                    f"-ExpectedSidecarHash {ps_quote(hashes['sip-sidecar.mjs'])}",
                    f"-ExpectedScenarioHash {ps_quote(hashes['sales-call-scenario.json'])}",
                    f"-ExpectedReadmeHash {ps_quote(hashes['README.md'])}",
                    f"-ExpectedServiceRatesHash {ps_quote(hashes['nbr-service-rates.json'])}",
                    f"-ExpectedScenarioVersion {expected_version}",
                ]
            ),
            timeout=240,
        )
        deployment = json_from_output(deploy_output)

        verify_output = run_powershell(
            client,
            "Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; " + " ".join(
                [
                    f"$result=& {ps_quote(remote_verify_script)}",
                    f"-ExpectedSidecarHash {ps_quote(hashes['sip-sidecar.mjs'])}",
                    f"-ExpectedScenarioHash {ps_quote(hashes['sales-call-scenario.json'])}",
                    f"-ExpectedReadmeHash {ps_quote(hashes['README.md'])}",
                    f"-ExpectedServiceRatesHash {ps_quote(hashes['nbr-service-rates.json'])}",
                    f"-ExpectedScenarioVersion {expected_version}",
                    f"-ProductCardBase64 {ps_quote(product_card_base64)};",
                    f"New-Item -ItemType Directory -Path {ps_quote(str(Path(canonical_report).parent))} -Force|Out-Null;",
                    f"[IO.File]::WriteAllText({ps_quote(report_path)},$result,[Text.UTF8Encoding]::new($false));",
                    f"Copy-Item -LiteralPath {ps_quote(report_path)} -Destination {ps_quote(canonical_report)} -Force;",
                    "$result",
                ]
            ),
            timeout=300,
        )
        verification = json_from_output(verify_output)
        if verification.get("status") != "ok":
            raise RuntimeError("Remote verification did not return status=ok")
        return {
            "status": "ok",
            "target": host,
            "scenario_version": expected_version,
            "stage_path": stage_root,
            "verification_report": canonical_report,
            "preflight": preflight,
            "deployment": deployment,
            "verification": verification,
            "hashes": {
                "sip_sidecar": hashes["sip-sidecar.mjs"].lower(),
                "scenario": hashes["sales-call-scenario.json"].lower(),
                "nbr_service_rates": hashes["nbr-service-rates.json"].lower(),
            },
            "secrets_printed": False,
        }
    except Exception:
        if copied and client.get_transport() and client.get_transport().is_active():
            rollback = "\n".join(
                [
                    "$ErrorActionPreference='Continue'",
                    "Disable-ScheduledTask -TaskName 'AgenticMail-SIP-Sidecar-Watchdog' -ErrorAction SilentlyContinue|Out-Null",
                    "Stop-ScheduledTask -TaskName 'AgenticMail-SIP-Sidecar-Watchdog' -ErrorAction SilentlyContinue",
                    "Stop-ScheduledTask -TaskName 'AgenticMail-SIP-Sidecar-Service' -ErrorAction SilentlyContinue",
                    "Start-Sleep -Seconds 2",
                    *[
                        (
                            f"$target={ps_quote(remote_sidecar_root + chr(92) + name)};"
                            f"$backup=\"$target.tnved-{stamp}.bak\";"
                            "if(Test-Path -LiteralPath $backup){"
                            "Copy-Item -LiteralPath $backup -Destination $target -Force}"
                        )
                        for name in VOICE_FILES
                    ],
                    (
                        "$config='C:\\Users\\pavel\\.agenticmail\\pbx199.local.json';"
                        f"$backup=\"$config.tnved-{stamp}.bak\";"
                        "if(Test-Path -LiteralPath $backup){"
                        "Copy-Item -LiteralPath $backup -Destination $config -Force}"
                    ),
                    "Start-ScheduledTask -TaskName 'AgenticMail-SIP-Sidecar-Service' -ErrorAction SilentlyContinue",
                    "Enable-ScheduledTask -TaskName 'AgenticMail-SIP-Sidecar-Watchdog' -ErrorAction SilentlyContinue|Out-Null",
                    "Start-ScheduledTask -TaskName 'AgenticMail-SIP-Sidecar-Watchdog' -ErrorAction SilentlyContinue",
                ]
            )
            try:
                run_powershell(client, rollback, timeout=120)
            except Exception:
                pass
        raise
    finally:
        password = ""
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="10.1.0.18")
    parser.add_argument(
        "--credential-path",
        type=Path,
        default=Path(r"X:\Paul\10.1.0.18.txt"),
    )
    parser.add_argument(
        "--remote-agenticmail-root",
        default=r"C:\codex_tools\agenticmail",
    )
    args = parser.parse_args()
    result = deploy(
        host=args.host,
        credential_path=args.credential_path,
        remote_agenticmail_root=args.remote_agenticmail_root,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
