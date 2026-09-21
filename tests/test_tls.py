"""The certificate that makes the microphone possible.

Nothing here is about cryptographic strength -- a self-signed certificate on a
home LAN is a formality the browser demands before it will treat the page as a
secure context, and a secure context is the only thing that gets `getUserMedia`
to return a microphone. What is worth testing is that it is generated at all,
that it names the addresses someone will actually type, and that it is written
once rather than on every restart: a certificate that changed each boot would
train the reader to click through warnings, which defeats the point.
"""

import pathlib
import ssl
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.tls import ensure_cert, local_names


def test_it_names_somewhere_you_could_type():
    names, addresses = local_names()
    assert "localhost" in names, names
    assert "127.0.0.1" in addresses, addresses
    print("  the certificate will at least name localhost ... ok")


def test_a_certificate_appears_and_then_stays_put():
    with tempfile.TemporaryDirectory() as tmp:
        directory = pathlib.Path(tmp) / "tls"
        cert, key = ensure_cert(directory)
        assert cert.exists() and key.exists()
        assert cert.read_bytes().startswith(b"-----BEGIN CERTIFICATE-----")
        assert key.stat().st_mode & 0o077 == 0, oct(key.stat().st_mode)

        # It parses as a certificate, which is more than "the file is not empty".
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))

        first = cert.read_bytes()
        again_cert, again_key = ensure_cert(directory)
        assert (again_cert, again_key) == (cert, key)
        assert cert.read_bytes() == first, "regenerated a certificate that already existed"
        print("  generated once, reused after ... ok")


if __name__ == "__main__":
    test_it_names_somewhere_you_could_type()
    test_a_certificate_appears_and_then_stays_put()
    print("\nall tls tests passed")
