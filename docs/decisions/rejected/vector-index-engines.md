# Vector index engines

Source: hands-on evaluation on 6 November 2026, run on this Mac against AIO's own code and stores. These are recorded stances, not current claims. Reopening needs the condition below, not another unscoped sweep.

## LEANN low-storage vector index

- Stance: Rejected.
- Reason: It saves disk, which AIO does not lack: vector data was 2.4 GB of about 99 GB, with 1.1 TB free, so the most it could save was about 1 GB. It is also far too slow for AIO's send path. On 38,355 chunks a search took 3.3 s (18 s when cold) against the 500 ms context deadline, and 1.7 s on a 1,110-item store where AIO's exact search takes 0.5 ms. The default low-storage index refuses updates ("Rebuild required"). Its small updatable mode took 30 to 50 s to add one item and 69 s to add five, and 50 items were still unfinished after 6 minutes, against about 7,500 new items a day, and its fast updatable mode stores every vector, so it saves nothing. It would add a 1.3 GB Python stack to an Electron app. The technique itself is sound: 96.6% of top-10 results matched exact search.
- Evidence caution: LEANN's README says it finds 2.1 times more relevant code than BM25. Its benchmark scripts have no BM25 arm, and the raw results in its repo show it ending with less relevant code covered than plain Claude Code (26% against 33%). They may be a different run, so treat the claim as unverified rather than false.
- Reopen when: AIO needs semantic search over a corpus far larger than it holds now, disk is a real constraint on that corpus, several seconds per search is acceptable there, and LEANN can be used without a Python runtime.

## Embeddings for code search

- Stance: Rejected for now.
- Reason: On 197 real commit descriptions, any-word keyword search put the right source file in the top 10 for 70.6% of queries. A stronger embedding model reached 58.4%, a gap of 12 points (95% CI 5.6 to 18.8), and adding embeddings to keywords gained nothing measurable. Real embeddings do help natural-language matching: with the bge-small model AIO ships, the right skill came first 14 and 16 of 17 times on two prompt sets, against 6 of 17 for the word hash on the first set, so they are worth having for memory and skills.
- Reopen when: A benchmark on this repo's commit-subject method shows an embedding model or hybrid beating keyword search by more than the noise, per `docs/CODEBASE_INDEXING_PERFORMANCE.md`.
