"""Serving the UI over https, so the browser will hand it a microphone.

Dictation and live voice chat are not a feature this app can choose to ship.
They are `getUserMedia`, and browsers gate capture on a *secure context*: https
or localhost, and nothing else. `http://10.0.0.247:8817` is not one, however
private that network is, and no amount of site settings will make it one. So a
phone on the same LAN as the box got no microphone button, and the honest
explanation ("voice needs https") is not much comfort when you are holding the
phone.

The fix is to also serve https, on a second port, with a certificate nobody
else trusts -- which is still a certificate: click through the warning once and
the origin is secure, capture works, and the thread, the stage and the
recording carry on unchanged. Alongside rather than instead, so nothing already
pointed at the plain port has to move. It is not a real certificate: you will
see an interstitial the first time on each device, and you still do not get the
install-to-home-screen prompt. Where you can get a real one (Tailscale's proxy,
Caddy, an existing reverse proxy) that is the better answer; this is for the
case where you cannot, which is most home networks.

Generated once and kept under AUTORA_HOME, so the warning is a one-time cost
per device rather than per restart -- a certificate that changes every boot
would retrain you to click through warnings, which is the opposite of the point.
"""

from __future__ import annotations

import ipaddress
import socket
import subprocess
from pathlib import Path

#: Browsers cap self-signed lifetimes well below the old 10-year habit; Safari
#: rejects anything over 825 days outright.
VALID_DAYS = 820


def local_names() -> tuple[list[str], list[str]]:
    """Every name and address this machine might be reached by, best effort.

    Only to keep the warning down to one click instead of two: a certificate
    that names the address you typed raises a plain "unknown issuer" rather
    than also a name mismatch. Anything that cannot be resolved is skipped --
    none of it is load-bearing.
    """
    names = {"localhost"}
    addresses = {"127.0.0.1", "::1"}

    try:
        hostname = socket.gethostname()
    except OSError:
        hostname = ""
    if hostname:
        names.add(hostname)
        names.add(f"{hostname}.local")
        try:
            _, _, resolved = socket.gethostbyname_ex(hostname)
            addresses.update(resolved)
        except (OSError, UnicodeError):
            pass

    # The address a packet to the outside world would leave from -- which is
    # the one someone on the LAN will type. No traffic is sent; a connected UDP
    # socket only picks a route.
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        addresses.add(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()

    valid = []
    for address in addresses:
        try:
            ipaddress.ip_address(address)
        except ValueError:
            continue
        valid.append(address)
    return sorted(names), sorted(valid)


def ensure_cert(directory: Path) -> tuple[Path, Path]:
    """Return (certfile, keyfile), generating a self-signed pair if needed."""
    directory.mkdir(parents=True, exist_ok=True)
    cert = directory / "cert.pem"
    key = directory / "key.pem"
    if cert.exists() and key.exists():
        return cert, key

    names, addresses = local_names()
    try:
        _write_with_cryptography(cert, key, names, addresses)
    except ImportError:
        _write_with_openssl(cert, key, names, addresses)
    # The key is readable by its owner and nobody else, the same as ssh would.
    key.chmod(0o600)
    return cert, key


def _write_with_cryptography(
    cert: Path, key: Path, names: list[str], addresses: list[str]
) -> None:
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    private = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Autora")])
    now = datetime.datetime.now(datetime.UTC)
    alt: list[x509.GeneralName] = [x509.DNSName(n) for n in names]
    alt += [x509.IPAddress(ipaddress.ip_address(a)) for a in addresses]

    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private.public_key())
        .serial_number(x509.random_serial_number())
        # A minute of slack: a container whose clock is a few seconds behind the
        # phone looking at it would otherwise serve a certificate from the future.
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=VALID_DAYS))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(private, hashes.SHA256())
    )

    key.write_bytes(private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))


def _write_with_openssl(
    cert: Path, key: Path, names: list[str], addresses: list[str]
) -> None:
    """Fall back to the openssl binary where the Python library is missing.

    Worth the second path: `pip install autora` pulls in no crypto library, and
    "install another package before you can turn on the microphone" is exactly
    the kind of errand that makes a feature go unused.
    """
    san = ",".join([*(f"DNS:{n}" for n in names), *(f"IP:{a}" for a in addresses)])
    try:
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256",
             "-days", str(VALID_DAYS), "-nodes",
             "-keyout", str(key), "-out", str(cert),
             "-subj", "/CN=Autora", "-addext", f"subjectAltName={san}"],
            check=True, capture_output=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "--tls needs a certificate and this machine has neither the "
            "`cryptography` package nor the `openssl` command to make one. "
            "Install one of them (pip install 'autora[tls]'), or pass a "
            "certificate you already have with --tls-cert/--tls-key."
        ) from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or b"").decode("utf-8", "replace").strip()
        raise RuntimeError(f"openssl could not write a certificate: {detail}") from exc
