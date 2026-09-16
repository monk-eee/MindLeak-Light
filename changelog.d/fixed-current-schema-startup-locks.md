- Avoid redundant column and index DDL when opening an already-migrated
  database, preventing startup lock timeouts and conflicting lock acquisition
  with active readers or writers. Preserve fresh-install and upgrade schema
  behaviour and add a PostgreSQL regression for both transaction lock modes.
