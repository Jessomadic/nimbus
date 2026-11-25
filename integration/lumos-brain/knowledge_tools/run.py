"""Preserve generic CLI; explicit publication verbs only."""
import sys
if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in {"publish-nimbus", "publication-status"}:
        from kb.publication_cli import entry
        action, flags = sys.argv[1], sys.argv[2:]
        cut = next((i for i, v in enumerate(flags) if v in {"--request", "--request-id"}), len(flags))
        entry(flags[:cut] + [action] + flags[cut:])
    else:
        from kb.cli import entry
        entry()
