"""Serving the UI over https, so the browser will hand it a microphone.

Dictation and live voice chat are not a feature this app can choose to ship.
They are `getUserMedia`, and browsers gate capture on a *secure context*: https
or localhost, and nothing else. `http://10.0.0.247:8817` is not one, however
private that network is, and no amount of site settings will make it one. So a
phone on the same LAN as the box got no microphone button, and the honest
explanation ("voice needs https") is not much comfort when you are holding the
phone.

The fix is to also serve https, on a second port, alongside http rather than
instead of it, so nothing already pointed at the plain port has to move.

Which leaves the question of what certificate. A bare self-signed one works --
click through the warning and the origin is secure and the microphone opens --
but it is a warning on every device, forever, and a browser will not *install*
a site it does not trust, so the home screen icon stays a bookmark. Both of
those are the same fact wearing two hats: nothing vouches for the certificate.

So Autora runs a small certificate authority of its own instead. The authority
is generated once and kept here; the server certificate is signed by it; and
the authority's public half is offered for download, to install on a phone the
way you would any other certificate. Do that once per device and the warning is
gone, the microphone works, and the page installs to the home screen as a real
app -- because as far as that device is concerned, this is now an ordinary
trusted site.

The cost, which belongs in front of the reader rather than in a footnote: an
authority you install can vouch for *any* site to that device. Its private key
lives here, readable by nobody else, and that is the whole of the protection.
On a home server it is a fair trade; on a shared machine it is not.

Leaf certificates are minted per hostname on demand, from the name the browser
asks for. That is the difference between this working and this being another
round of "it says the certificate is for the wrong name": reach the box by
tailnet name, by `.local`, by IP, by anything, and the certificate matches,
because it is issued after the question is asked rather than guessed at
beforehand.
"""

from __future__ import annotations

import datetime
import hashlib
import ipaddress
import re
import socket
import subprocess
import typing
from pathlib import Path

if typing.TYPE_CHECKING:
    import ssl

#: Under Chrome's 398-day ceiling rather than near Safari's 825.
#:
#: The ceiling is documented as applying to publicly trusted roots, with
#: locally installed ones exempt, so 820 days should have been fine. "Should
#: have been" is the problem: a certificate rejected for being too long-lived
#: and one rejected because the authority is not trusted both present as a
#: browser refusing the page, and ruling this out costs nothing while guessing
#: about it has cost plenty.
VALID_DAYS = 397

#: Bumped whenever anything about how a certificate is built changes. It is
#: mixed into the cache key, so a policy change re-mints instead of serving the
#: certificate it was meant to replace -- which would make a fix look inert.
ISSUE_POLICY = "2"


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


#: The authority outlives the certificates it signs -- reinstalling it on every
#: device once a year would be the same chore this exists to end.
CA_DAYS = 3650


def ensure_ca(directory: Path) -> tuple[Path, Path]:
    """Return (ca_cert, ca_key), creating the authority on first use."""
    directory.mkdir(parents=True, exist_ok=True)
    cert, key = directory / "ca.crt", directory / "ca.key"
    if cert.exists() and key.exists():
        return cert, key

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    private = ec.generate_private_key(ec.SECP256R1())
    # Named for the machine, because this ends up in a list on someone's phone
    # next to Amazon and DigiCert, and "Autora" alone would not say which box.
    label = f"Autora on {socket.gethostname() or 'this server'}"
    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, label),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Autora"),
    ])
    now = _now()
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False,
                key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=True, crl_sign=True,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(private.public_key()),
            critical=False,
        )
        .sign(private, hashes.SHA256())
    )

    key.write_bytes(private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    key.chmod(0o600)
    cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return cert, key


def issue(
    directory: Path, names: list[str], addresses: list[str]
) -> tuple[Path, Path]:
    """Sign a certificate for these names, and return where it was written.

    Cached by the names it covers, so a browser reconnecting to a host we have
    already served does not pay for a key generation, and a restart does not
    invalidate what a device has already seen.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    ca_cert_path, ca_key_path = ensure_ca(directory)
    issued = directory / "issued"
    issued.mkdir(parents=True, exist_ok=True)

    stem = hashlib.sha256(
        "\n".join([ISSUE_POLICY, *names, *addresses]).encode()
    ).hexdigest()[:16]
    cert_path, key_path = issued / f"{stem}.crt", issued / f"{stem}.key"
    if cert_path.exists() and key_path.exists():
        return cert_path, key_path

    ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
    ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)

    alt: list[x509.GeneralName] = [x509.DNSName(n) for n in names]
    alt += [x509.IPAddress(ipaddress.ip_address(a)) for a in addresses]
    if not alt:
        raise RuntimeError("a certificate has to be for something")

    private = ec.generate_private_key(ec.SECP256R1())
    now = _now()
    certificate = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, names[0] if names else addresses[0]),
        ]))
        .issuer_name(ca_cert.subject)
        .public_key(private.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=VALID_DAYS))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(private.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    key_path.write_bytes(private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    key_path.chmod(0o600)
    # The chain, not the leaf alone: a device that has the authority installed
    # is fine either way, but anything checking the chain without it gets a
    # useful error rather than a confusing one.
    cert_path.write_bytes(
        certificate.public_bytes(serialization.Encoding.PEM) + ca_cert_path.read_bytes()
    )
    return cert_path, key_path


def ensure_cert(directory: Path) -> tuple[Path, Path]:
    """The certificate to start the listener with, before anyone has connected.

    A browser that sends the hostname it asked for gets one minted for exactly
    that name (see `sni_context`); this is the fallback for everything else --
    an IP typed directly, an old client, a health check.
    """
    names, addresses = local_names()
    try:
        return issue(directory, names, addresses)
    except ImportError:
        # No `cryptography`: no authority, no per-name minting, but a plain
        # self-signed certificate still opens the microphone. Worse, not absent.
        directory.mkdir(parents=True, exist_ok=True)
        cert, key = directory / "cert.pem", directory / "key.pem"
        if not (cert.exists() and key.exists()):
            _write_with_openssl(cert, key, names, addresses)
            key.chmod(0o600)
        return cert, key


_SAFE_HOST = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,252}[a-z0-9])?$")


def sni_context(directory: Path, base: ssl.SSLContext) -> None:
    """Teach a context to answer for whatever hostname it is asked about.

    Guessing the names a box will be reached by is the thing that does not
    work: it is a tailnet name today, `.local` tomorrow, a bare IP when the
    DNS breaks, and a certificate that omits any of them is a warning again --
    which for the reader is indistinguishable from this never having worked.
    The client states the name it wants during the handshake, so the answer is
    to issue then rather than predict.
    """
    import ssl

    cache: dict[str, ssl.SSLContext] = {}

    def choose(sock, server_name: str | None, _context) -> None:
        if not server_name:
            return
        host = server_name.lower().rstrip(".")
        existing = cache.get(host)
        if existing is None:
            if not _SAFE_HOST.match(host):
                # Not a name we will put in a certificate, and not worth
                # failing the handshake over either: the default answers.
                return
            try:
                as_ip = str(ipaddress.ip_address(host))
            except ValueError:
                as_ip = ""
            try:
                cert, key = issue(
                    directory,
                    [] if as_ip else [host],
                    [as_ip] if as_ip else [],
                )
                existing = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                existing.load_cert_chain(str(cert), str(key))
            except Exception:
                # Anything at all here would otherwise abort the handshake with
                # no explanation on either side. The default certificate is a
                # warning; a dead connection is a mystery.
                return
            cache[host] = existing
        sock.context = existing

    base.sni_callback = choose


def _now():
    # A minute of slack is applied by the callers: a container whose clock is a
    # few seconds behind the phone looking at it would otherwise serve a
    # certificate from the future.
    return datetime.datetime.now(datetime.UTC)


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
