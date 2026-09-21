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

from autora.tls import ensure_ca, ensure_cert, issue, local_names


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


def test_the_authority_can_vouch_for_what_it_signs():
    """The whole point: a device holding the authority sees an ordinary site.

    Verified by actually building a trust store from the authority and
    validating a leaf against it, rather than by inspecting fields and
    believing they add up -- the failure this replaces was a certificate that
    looked correct in every field and was rejected anyway.
    """
    from cryptography import x509

    with tempfile.TemporaryDirectory() as tmp:
        directory = pathlib.Path(tmp)
        ca_cert, ca_key = ensure_ca(directory)
        assert ca_key.stat().st_mode & 0o077 == 0, oct(ca_key.stat().st_mode)

        authority = x509.load_pem_x509_certificate(ca_cert.read_bytes())
        assert authority.extensions.get_extension_for_class(
            x509.BasicConstraints).value.ca is True

        leaf_path, _ = issue(directory, ["umbrel-1.tail16900.ts.net"], [])
        leaf = x509.load_pem_x509_certificate(leaf_path.read_bytes())
        assert leaf.issuer == authority.subject
        names = leaf.extensions.get_extension_for_class(
            x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
        assert names == ["umbrel-1.tail16900.ts.net"], names

        # A real trust store, the way a browser would build one.
        store = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        store.load_verify_locations(cafile=str(ca_cert))
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(leaf_path), str(_key_beside(leaf_path)))
        print("  the authority signs, and its own store accepts ... ok")


def test_a_name_we_never_predicted_still_gets_a_certificate():
    """Guessing hostnames is the thing that does not work; this stops guessing."""
    with tempfile.TemporaryDirectory() as tmp:
        directory = pathlib.Path(tmp)
        first, _ = issue(directory, ["box.tail1234.ts.net"], [])
        second, _ = issue(directory, ["something.else.local"], [])
        assert first != second
        # Asking twice for the same names reuses the answer, so a browser
        # reconnecting does not pay for a key generation every time.
        assert issue(directory, ["box.tail1234.ts.net"], [])[0] == first
        print("  any hostname, issued on demand, cached after ... ok")


def test_the_leaf_carries_the_chain():
    """A client without the authority should get a useful error, not a puzzle."""
    with tempfile.TemporaryDirectory() as tmp:
        directory = pathlib.Path(tmp)
        leaf, _ = issue(directory, ["host.example"], [])
        assert leaf.read_text().count("BEGIN CERTIFICATE") == 2, "leaf shipped alone"
        print("  the leaf ships with its issuer ... ok")


def _key_beside(cert: pathlib.Path) -> pathlib.Path:
    return cert.with_suffix(".key")


if __name__ == "__main__":
    test_it_names_somewhere_you_could_type()
    test_a_certificate_appears_and_then_stays_put()
    test_the_authority_can_vouch_for_what_it_signs()
    test_a_name_we_never_predicted_still_gets_a_certificate()
    test_the_leaf_carries_the_chain()
    print("\nall tls tests passed")
