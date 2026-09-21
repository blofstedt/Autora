"""The check that stops a release nobody can install.

Built against real git repositories rather than stubbed diffs, because every
way this has actually gone wrong was about what `git diff` reported between
which two commits -- and a test that hands the code a list of filenames would
have agreed with all of them.
"""

import importlib.util
import pathlib
import re
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location(
    "check_release", ROOT / ".github" / "scripts" / "check_release.py"
)
check_release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_release)


MANIFEST = """manifestVersion: 1
id: blofstedt-autora
name: Autora
version: "{version}"
port: 8817
description: >-
  An agent you can watch.
releaseNotes: >-
  {notes}
dependencies: []
"""


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          check=True, capture_output=True, text=True).stdout


def _commit(repo, message):
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)


def _repo(stack):
    """A repository with main at 0.5.4, and a branch to put changes on."""
    repo = pathlib.Path(stack.enter_context(tempfile.TemporaryDirectory()))
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "Test")

    (repo / "blofstedt-autora").mkdir()
    (repo / "src" / "autora").mkdir(parents=True)
    (repo / "tests").mkdir()
    manifest = repo / "blofstedt-autora" / "umbrel-app.yml"
    manifest.write_text(MANIFEST.format(version="0.5.4", notes="You can talk to it now."))
    (repo / "src" / "autora" / "agent.py").write_text("x = 1\n")
    (repo / "README.md").write_text("# Autora\n")
    _commit(repo, "base")
    _git(repo, "checkout", "-q", "-b", "work")
    return repo, manifest


def _run(repo, monkey=None, base="main", head="work"):
    """Run the check inside `repo`, as CI would, returning its exit code."""
    import contextlib
    import io
    import os

    environ = {"PR_TITLE": "", "PR_BODY": "", **(monkey or {})}
    old_cwd = os.getcwd()
    old_env = {k: os.environ.get(k) for k in environ}
    os.chdir(repo)
    os.environ.update(environ)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return check_release.main(["--base", base, "--head", head])
    finally:
        os.chdir(old_cwd)
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_the_exact_bug_is_caught():
    """Code changed, manifest untouched -- the release that ships to nobody."""
    import contextlib
    with contextlib.ExitStack() as stack:
        repo, _ = _repo(stack)
        (repo / "src" / "autora" / "agent.py").write_text("x = 2\n")
        _commit(repo, "fix the agent")
        assert _run(repo) == 1
        print("  a code change with no bump fails ... ok")


def test_a_proper_release_passes():
    import contextlib
    with contextlib.ExitStack() as stack:
        repo, manifest = _repo(stack)
        (repo / "src" / "autora" / "agent.py").write_text("x = 2\n")
        manifest.write_text(MANIFEST.format(version="0.5.5", notes="Reasoning stays folded."))
        _commit(repo, "fix the agent, and say so")
        assert _run(repo) == 0
        print("  a bump with fresh notes passes ... ok")


def test_stale_notes_are_caught():
    """Notes are what Umbrel shows; last release's news is worse than none."""
    import contextlib
    with contextlib.ExitStack() as stack:
        repo, manifest = _repo(stack)
        (repo / "src" / "autora" / "agent.py").write_text("x = 2\n")
        manifest.write_text(MANIFEST.format(version="0.5.5", notes="You can talk to it now."))
        _commit(repo, "bump and forget")
        assert _run(repo) == 1
        print("  a bump carrying the previous release's notes fails ... ok")


def test_a_version_that_is_not_an_upgrade_is_caught():
    import contextlib
    with contextlib.ExitStack() as stack:
        repo, manifest = _repo(stack)
        (repo / "src" / "autora" / "agent.py").write_text("x = 2\n")
        manifest.write_text(MANIFEST.format(version="0.5.3", notes="Went backwards."))
        _commit(repo, "bump the wrong way")
        assert _run(repo) == 1
        print("  a version that went backwards fails ... ok")


def test_prose_and_tests_are_free():
    """A check that fires on a README typo is one people learn to merge past."""
    import contextlib
    with contextlib.ExitStack() as stack:
        repo, _ = _repo(stack)
        (repo / "README.md").write_text("# Autora\n\nNow with a typo fixed.\n")
        (repo / "tests" / "test_new.py").write_text("def test_x(): pass\n")
        _commit(repo, "docs and a test")
        assert _run(repo) == 0
        print("  docs and tests need no release ... ok")


def test_the_opt_out_works():
    import contextlib
    with contextlib.ExitStack() as stack:
        repo, _ = _repo(stack)
        (repo / "src" / "autora" / "agent.py").write_text("x = 2\n")
        _commit(repo, "rename a local")
        assert _run(repo) == 1
        assert _run(repo, {"PR_BODY": "Pure refactor. [no release]"}) == 0
        assert _run(repo, {"PR_TITLE": "Tidy internals [No Release]"}) == 0
        print("  an internal-only change can say so and pass ... ok")


def test_main_moving_underneath_is_not_this_branch_s_problem():
    """Two-dot diffs blame a branch for what someone else pushed to main."""
    import contextlib
    with contextlib.ExitStack() as stack:
        repo, _ = _repo(stack)
        (repo / "README.md").write_text("# Autora\n\nDocs only.\n")
        _commit(repo, "docs only")

        _git(repo, "checkout", "-q", "main")
        (repo / "src" / "autora" / "agent.py").write_text("someone = 'else'\n")
        _commit(repo, "somebody else changes the app")
        _git(repo, "checkout", "-q", "work")

        assert _run(repo) == 0
        print("  a docs branch is not failed by main's commits ... ok")


def test_a_push_to_main_is_checked_too():
    """Work lands on main directly here, so the push event has to work."""
    import contextlib
    with contextlib.ExitStack() as stack:
        repo, _ = _repo(stack)
        _git(repo, "checkout", "-q", "main")
        before = _git(repo, "rev-parse", "HEAD").strip()
        (repo / "src" / "autora" / "agent.py").write_text("x = 2\n")
        _commit(repo, "straight to main, no bump")
        assert _run(repo, base="main~1", head="main") == 1

        # And the case a push event cannot answer: no `before` to compare to.
        assert _run(repo, base=check_release.EMPTY_SHA, head="main") == 1
        assert _run(repo, base="", head="main") == 1
        assert before  # the commit it should have fallen back to
        print("  a push straight to main is caught, with or without a base ... ok")


def test_version_ordering_is_numeric():
    assert check_release.newer("0.5.10", "0.5.9")
    assert check_release.newer("0.6.0", "0.5.99")
    assert not check_release.newer("0.5.9", "0.5.10")
    assert not check_release.newer("0.5.4", "0.5.4")
    print("  0.5.10 is above 0.5.9, not below it ... ok")


def test_the_real_manifest_is_readable():
    """The parsers are regexes; the file they parse is the one that ships."""
    manifest = (ROOT / "blofstedt-autora" / "umbrel-app.yml").read_text()
    version = check_release.version_of(manifest)
    assert version and version[0].isdigit(), version
    notes = check_release.release_notes_of(manifest)
    assert len(notes) > 40, notes
    assert "dependencies" not in notes, "the notes block ran past its key"
    print(f"  the shipped manifest reads as {version} with real notes ... ok")


def test_the_two_versions_agree():
    """The store's version and the app's own version are the same string.

    They answer the same question in two places: Umbrel reads the manifest to
    decide an update exists, and the app reports `__version__` to whoever asks
    whether their update arrived -- the page banner, Settings, the relay's
    probe. Drift between them makes the app deny a release the store has
    already shipped, which is precisely the confusion the banner exists to end.
    """
    manifest = (ROOT / "blofstedt-autora" / "umbrel-app.yml").read_text()
    shipped = check_release.version_of(manifest)
    source = (ROOT / "src" / "autora" / "__init__.py").read_text()
    match = re.search(r'__version__\s*=\s*"([^"]+)"', source)
    assert match, "no __version__ in src/autora/__init__.py"
    assert match.group(1) == shipped, (
        f"__init__.py says {match.group(1)}, the manifest says {shipped}"
    )
    print(f"  manifest and __version__ both say {shipped} ... ok")


if __name__ == "__main__":
    test_the_exact_bug_is_caught()
    test_a_proper_release_passes()
    test_stale_notes_are_caught()
    test_a_version_that_is_not_an_upgrade_is_caught()
    test_prose_and_tests_are_free()
    test_the_opt_out_works()
    test_main_moving_underneath_is_not_this_branch_s_problem()
    test_version_ordering_is_numeric()
    test_the_real_manifest_is_readable()
    test_the_two_versions_agree()
    print("\nall release check tests passed")
