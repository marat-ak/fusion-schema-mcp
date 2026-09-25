module fusion-schema-mcp/entry

go 1.23

require github.com/marat-ak/oservices-setup/config v0.1.0

// Resolved against the Docker build layout: the Dockerfile's `entry` stage COPYs the named build
// context `oservices-config` (compose build.additional_contexts → ../oservices-setup/config) to
// /src/config and this dir to /src/entry, siblings under /src.
replace github.com/marat-ak/oservices-setup/config => ../config
