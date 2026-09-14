// Shell-free replacement for muninn's scripts/docker-entrypoint.sh, for the
// Docker Hardened Images Bun runtime, which carries no /bin/sh. Same order, same
// refusals: adopt DB_URL, refuse an unprovisioned database, migrate, serve.
//
// The server is IMPORTED, not spawned. That keeps it in this process, so bun
// stays PID 1 and receives SIGTERM directly, which is what the `exec` in the
// shell version bought. src/index.ts has no `import.meta.main` guard and
// registers its own SIGTERM/SIGINT handlers, so the import is the whole start.
//
// Not carried over: `exec "$@"`. A pod that needs a different command sets
// `command:` (nais/provision-job.yaml does), which replaces this entrypoint.

// nais injects DB_URL (`envVarPrefix: DB`). DATABASE_URL wins when both are set,
// and an empty DB_URL is not adopted.
if (!process.env.DATABASE_URL && process.env.DB_URL) {
  process.env.DATABASE_URL = process.env.DB_URL;
  console.log("[entrypoint] DATABASE_URL adopted from DB_URL");
}

// Each check runs as its own process. require-provisioned must, because the
// migration runner creates `schema_migrations` itself (see its header).
for (const script of ["db/require-provisioned.ts", "db/migrate.ts"]) {
  const result = Bun.spawnSync([process.execPath, script], {
    cwd: import.meta.dir,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) {
    // require-provisioned exits 1 (not provisioned) or 2 (could not ask); the
    // code is passed through so the pod status says which. A signal-killed
    // child has a null exit code, which must still fail the container.
    console.error(
      `[entrypoint] ${script} failed (${result.exitCode === null ? `signal ${result.signalCode}` : `exit ${result.exitCode}`}); not starting the server`,
    );
    process.exit(result.exitCode || 1);
  }
}

await import("./src/index.ts");
