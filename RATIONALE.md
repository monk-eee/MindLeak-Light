# Why Light

The useful unit is an independent fact with provenance, not another paragraph
in a growing transcript. Decomposition is therefore part of every write.

PostgreSQL handles concurrent agents, durability, and remote deployment from the
start. pgvector keeps retrieval in that same database. There is no SQLite migration
waiting in the design and no separate vector service to operate.

The repository keeps MindLeak's Rust setup and engineering discipline. It does
not inherit MindLeak's coordination architecture. Five library responsibilities
compile into one executable; they are not five services.

The retriever remains replaceable. RAST can be added behind that interface when
there is evidence it is needed. It is not required to make this version useful.
