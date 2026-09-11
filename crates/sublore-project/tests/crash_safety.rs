//! CONTRIBUTING §3 rule 4, written from the criteria in docs/database-survives-a-crash-tasks.md:
//! "The project database is append-safe: crashes may lose the last operation, never the database."
//!
//! `db.rs` sets `synchronous = 2` and `journal_mode = WAL` and re-reads both, which is the
//! configuration the rule needs. This is the other half: the database is opened, written to, and
//! the process is killed, and what reopens is read. Nothing in the shipping crate changes for it,
//! because the kill happens in the child's own test code rather than at a fault point inside a
//! library function.
//!
//! Same shape as `sublore-io/tests/crash_injection.rs`: an `abort()` cannot be observed in-process,
//! so every case re-runs this test binary as a child with a point armed by an environment variable.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use sublore_project::layout::database_path;
use sublore_project::records::{add_episode, Project};
use sublore_project::Database;

/// Set by the parent to turn `crash_child` from a no-op into one run.
const CHILD_ENV: &str = "SUBLORE_PROJECT_CHILD";
const FOLDER_ENV: &str = "SUBLORE_PROJECT_FOLDER";
/// Each point is killed repeatedly: one green run of a crash test is not a frequency (D3).
const RUNS: usize = 5;
const CHILD_TIMEOUT: Duration = Duration::from_secs(60);

/// The three named episodes the parent insists on afterwards, whatever else happened.
const KEPT: [&str; 3] = ["first kept", "second kept", "third kept"];
/// What the bulk rows say once they are committed, and what the doomed write tries to make them
/// say instead. The parent counts the second one: after a crash before the commit there must be
/// none of it anywhere.
const SETTLED: &str = "settled before the doomed write";
const IN_FLIGHT: &str = "the write that was in flight when the process died";

/// Where the child aborts. Both sit around the commit, which is the only moment the rule is about.
const POINTS: [&str; 2] = ["before-commit", "after-commit"];
/// Rows committed before the doomed transaction, each one holding a page of its own. Three thousand
/// four-kilobyte rows is twelve megabytes of pages already on the disk, which is what the doomed
/// transaction then overwrites: far past any page cache, so SQLite has to write those pages back
/// before it can commit, and undoing them is exactly what the journal is for. Rewriting what is
/// there rather than appending is the whole point. An append allocates fresh pages at the end of
/// the file and never moves the header, so aborting one leaves the same database with or without a
/// journal, and a check built on it passes for no reason (measured, D4).
const BULK_ROWS: usize = 3_000;
/// Four kilobytes, which is a page: one row cannot share a page with another.
const PAYLOAD: usize = 4_096;

// ---------------------------------------------------------------------------
// The child half. A no-op unless the parent asked for one run.
// ---------------------------------------------------------------------------

#[test]
fn crash_child() {
    let Ok(point) = env::var(CHILD_ENV) else {
        return;
    };
    let folder = PathBuf::from(env::var(FOLDER_ENV).expect("the parent names the folder"));

    let now = SystemTime::now();
    let mut project =
        Project::create(&folder, "A crash test", now).expect("the project is created");
    for title in KEPT {
        add_episode(&mut project, title, now).expect("an episode is added");
    }
    project.close().expect("the project closes");

    // Reopened through the app's own `Database`, which is what applies `synchronous` and
    // `journal_mode`: a bare `Connection` would carry SQLite's defaults and prove something else.
    let mut database = Database::open(&folder).expect("the database reopens");
    let stamp = now
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs() as i64;

    let settled = format!("{SETTLED} {}", "x".repeat(PAYLOAD));
    let transaction = database
        .conn_mut()
        .transaction()
        .expect("a transaction can be opened");
    let mut insert = transaction
        .prepare(
            "INSERT INTO episodes (series_id, ordinal, title, created_at) VALUES (1, ?1, ?2, ?3)",
        )
        .expect("the statement prepares");
    for row in 0..BULK_ROWS {
        // The ordinal is counted here rather than selected: a correlated `MAX` per row is
        // quadratic, and it cost two minutes a run before it was written out.
        let ordinal = (KEPT.len() + 1 + row) as i64;
        insert
            .execute(rusqlite::params![ordinal, settled, stamp])
            .expect("the bulk episode is written");
    }
    drop(insert);
    transaction.commit().expect("the bulk lands on the disk");

    // The doomed write: one statement over every bulk row, so the pages it dirties are pages that
    // already hold committed data. The three named episodes are left alone, which is what lets the
    // parent read them back as the fixed point.
    let in_flight = format!("{IN_FLIGHT} {}", "y".repeat(PAYLOAD));
    let transaction = database
        .conn_mut()
        .transaction()
        .expect("a second transaction can be opened");
    transaction
        .execute(
            "UPDATE episodes SET title = ?1 WHERE ordinal > ?2",
            rusqlite::params![in_flight, KEPT.len() as i64],
        )
        .expect("the doomed update runs");

    if point == "before-commit" {
        std::process::abort();
    }
    transaction.commit().expect("the transaction commits");
    // After the commit, which the rule allows to have landed or not: what it does not allow is a
    // database that cannot be opened, or one that lost what was committed before it.
    std::process::abort();
}

// ---------------------------------------------------------------------------
// The parent half.
// ---------------------------------------------------------------------------

fn scratch(tag: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_nanos();
    let path = env::temp_dir().join(format!("sublore-project-crash-{tag}-{stamp}"));
    fs::create_dir_all(&path).expect("the scratch folder is created");
    path
}

/// Run the child once with `point` armed, and answer the folder it left behind.
fn killed_at(point: &str, run: usize) -> PathBuf {
    let folder = scratch(&format!("{point}-{run}"));
    let mut child = Command::new(env::current_exe().expect("the test binary knows its own path"))
        .args(["crash_child", "--exact", "--nocapture"])
        .env(CHILD_ENV, point)
        .env(FOLDER_ENV, &folder)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child starts");

    let deadline = std::time::Instant::now() + CHILD_TIMEOUT;
    loop {
        match child.try_wait().expect("the child can be waited on") {
            Some(status) => {
                assert!(
                    !status.success(),
                    "the child was asked to abort at {point} and exited cleanly instead"
                );
                break;
            }
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                panic!("the child armed at {point} did not abort within {CHILD_TIMEOUT:?}");
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    folder
}

/// What SQLite itself says about the file, which is the question the rule asks first.
fn integrity_of(folder: &Path) -> String {
    let connection =
        Connection::open(database_path(folder)).expect("the database opens after the crash");
    connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .expect("integrity_check answers")
}

/// The three named titles, and how many bulk rows carry the doomed write. Read with a plain
/// connection rather than through `episodes`, which would pull twelve megabytes of filler into
/// memory ten times over.
fn read_back(folder: &Path) -> (Vec<String>, usize) {
    let connection =
        Connection::open(database_path(folder)).expect("the database opens after the crash");
    let mut statement = connection
        .prepare("SELECT title FROM episodes WHERE ordinal <= ?1 ORDER BY ordinal")
        .expect("the statement prepares");
    let named: Vec<String> = statement
        .query_map([KEPT.len() as i64], |row| row.get(0))
        .expect("the named episodes are readable")
        .collect::<Result<_, _>>()
        .expect("every named title reads back");
    drop(statement);
    let in_flight: i64 = connection
        .query_row(
            "SELECT count(*) FROM episodes WHERE title LIKE ?1 || '%'",
            [IN_FLIGHT],
            |row| row.get(0),
        )
        .expect("the doomed rows can be counted");
    (named, in_flight as usize)
}

#[test]
fn a_crash_before_the_commit_leaves_every_episode_that_was_committed() {
    // D1. The update was written and not committed, so none of it may be visible; what was
    // committed before it has to be there, whole and unchanged.
    for run in 0..RUNS {
        let folder = killed_at("before-commit", run);
        assert_eq!(integrity_of(&folder), "ok", "run {run}");
        Project::open(&folder).expect("the project reopens after the crash");

        let (named, in_flight) = read_back(&folder);
        assert_eq!(named, KEPT, "run {run}: the named episodes must be intact");
        assert_eq!(
            in_flight, 0,
            "run {run}: an uncommitted write must not survive the crash"
        );
        fs::remove_dir_all(&folder).ok();
    }
}

#[test]
fn a_crash_after_the_commit_leaves_the_database_whole() {
    // D2. Whether the update survived is the one thing not asserted: the rule allows the last
    // operation to be lost. What it does not allow is a database that will not open, one that
    // forgot something older, or one holding half of a transaction.
    for run in 0..RUNS {
        let folder = killed_at("after-commit", run);
        assert_eq!(integrity_of(&folder), "ok", "run {run}");
        Project::open(&folder).expect("the project reopens after the crash");

        let (named, in_flight) = read_back(&folder);
        assert_eq!(named, KEPT, "run {run}: the named episodes must be intact");
        assert!(
            in_flight == 0 || in_flight == BULK_ROWS,
            "run {run}: the whole update landed or none of it did, and {in_flight} rows carry it"
        );
        fs::remove_dir_all(&folder).ok();
    }
}

#[test]
fn the_points_the_child_answers_to_are_the_ones_the_parent_arms() {
    // A point renamed on one side and not the other would make every case above a no-op that
    // aborts immediately and proves nothing.
    for point in POINTS {
        assert!(
            matches!(point, "before-commit" | "after-commit"),
            "{point} is not a point the child knows"
        );
    }
}
