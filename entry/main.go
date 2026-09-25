// Command entry is the fusion-schema-mcp container's startup wrapper (setup V1 task 9; entry
// contract: spec §6 / master C4). It waits for stack.fusion on the oservices-setup Config API,
// persists the module, reports its status and execs today's /entrypoint.sh — which keeps the
// CATALOG_DB sqlite|postgres gate and starts node /app/dist/server.js. V1 consumes ONE key,
// CATALOG_VERSION, for a boot log line: the catalog itself is data-plane (CATALOG_DB + DATABASE_URL
// stay bootstrap env and pass through untouched). It never logs any other module value.
package main

import (
	"log"

	config "github.com/marat-ak/oservices-setup/config"
)

const fusionModule = "stack.fusion"

// entrypoint is a var (not a const) so the test can assert the exec target without exec'ing.
var entrypoint = "/entrypoint.sh"

func main() {
	log.SetPrefix("[entry] ")

	c, err := config.FromEnv()
	if err != nil {
		log.Fatal(err)
	}

	c.WaitReady(fusionModule)

	rev, values, err := c.Fetch(fusionModule)
	if err != nil {
		log.Fatal(err)
	}

	if c.RevUnchanged(fusionModule, rev) {
		log.Printf("%s rev=%d unchanged", fusionModule, rev)
	} else {
		if err := c.Persist(fusionModule, rev, values); err != nil {
			log.Fatal(err)
		}
		log.Printf("%s rev=%d", fusionModule, rev)
	}
	log.Print(catalogLine(values))

	if err := c.ReportStatus(rev); err != nil {
		log.Printf("report status: %v", err)
	}

	// CATALOG_DB / DATABASE_URL / MCP_* are inherited from the container env unchanged (nil extraEnv).
	if err := config.Exec([]string{entrypoint}, nil); err != nil {
		log.Fatal(err)
	}
}

// catalogLine renders the pinned catalog version for the boot log. "(unset)" when the optional key is
// absent: the catalog actually served is whatever meta.active_version says in the fusion database;
// CATALOG_VERSION is the upgrade job's input (stack-install D14), not a selector here.
func catalogLine(values map[string]string) string {
	v := values["CATALOG_VERSION"]
	if v == "" {
		v = "(unset)"
	}
	return fusionModule + " CATALOG_VERSION=" + v
}
