package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The one V1 consumer of stack.fusion in this image is a log line: CATALOG_VERSION, and nothing else
// from the module ever reaches the log (BIP_PASSWORD is a secret key of the same module).
func TestCatalogLine_Set(t *testing.T) {
	got := catalogLine(map[string]string{
		"CATALOG_VERSION": "v2026_11",
		"BIP_URL":         "https://pod.example",
		"BIP_USER":        "svc",
		"BIP_PASSWORD":    "never-logged",
	})
	if got != "stack.fusion CATALOG_VERSION=v2026_11" {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "never-logged") || strings.Contains(got, "pod.example") {
		t.Fatalf("log line leaks module values: %q", got)
	}
}

func TestCatalogLine_Unset(t *testing.T) {
	if got := catalogLine(map[string]string{"BIP_URL": "https://pod.example"}); got != "stack.fusion CATALOG_VERSION=(unset)" {
		t.Fatalf("got %q", got)
	}
}

// The entry execs today's /entrypoint.sh unchanged, so its CATALOG_DB gate (sqlite|postgres, no
// default) is still what stops a misconfigured container — proven by running the real script with
// CATALOG_DB unset: exit 1 + the gate's message, before any node process is attempted.
func TestEntrypointKeepsCatalogDbGate(t *testing.T) {
	cmd := exec.Command("sh", "../entrypoint.sh")
	cmd.Env = append(os.Environ(), "CATALOG_DB=")
	out, err := cmd.CombinedOutput()
	exitErr, ok := err.(*exec.ExitError)
	if !ok || exitErr.ExitCode() != 1 {
		t.Fatalf("expected exit 1, got err=%v out=%s", err, out)
	}
	if !strings.Contains(string(out), `CATALOG_DB must be "sqlite" or "postgres"`) {
		t.Fatalf("gate message missing: %s", out)
	}
}

func TestExecArgvIsTodaysEntrypoint(t *testing.T) {
	if entrypoint != "/entrypoint.sh" {
		t.Fatalf("entry must exec today's script, got %q", entrypoint)
	}
}
