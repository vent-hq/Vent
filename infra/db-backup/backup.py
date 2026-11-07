"""Dump Postgres and upload it. Tigris expires backups after 30 days."""
from datetime import UTC, datetime
import os
import subprocess
import tempfile


def main():
    os.environ["PGPASSWORD"] = os.environ["POSTGRES_PASSWORD"]
    filename = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ.dump")
    destination = f"{os.environ['BACKUP_DESTINATION']}/{filename}"

    with tempfile.TemporaryDirectory() as directory:
        dump = os.path.join(directory, "vent.dump")
        subprocess.run(
            ["pg_dump", "--format=custom", "--no-owner", "--no-acl", "--file", dump],
            check=True,
        )
        subprocess.run(
            ["aws", "s3", "cp", dump, destination, "--only-show-errors"],
            check=True,
        )
    print(f"Backup uploaded: {destination}", flush=True)


if __name__ == "__main__":
    main()
