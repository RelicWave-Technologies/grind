//! 1:1 port of `legacy/agent/src/main/services/larkTaskCache.test.ts`.
#![cfg(test)]

use rusqlite::Connection;
use timo_store::lark_task_cache::{CachedLarkTask, LarkTaskCache, LarkTaskCacheOwner};

fn owner() -> LarkTaskCacheOwner {
    LarkTaskCacheOwner {
        user_id: "user-a".to_owned(),
        workspace_id: "workspace-a".to_owned(),
    }
}

fn task() -> CachedLarkTask {
    CachedLarkTask {
        guid: "task-a".to_owned(),
        summary: "Offline-safe task".to_owned(),
        completed: false,
        url: None,
        due: None,
        created_at: None,
        creator_id: None,
        creator_name: None,
        logged_ms: 0.0,
        logged_today_ms: 0.0,
        logged_total_ms: 0.0,
        extra: serde_json::Map::new(),
    }
}

fn cache() -> LarkTaskCache {
    LarkTaskCache::new(Connection::open_in_memory().unwrap()).unwrap()
}

const FETCHED_AT: f64 = 1_700_000_000_000.0;

mod lark_task_cache {
    use super::*;

    #[test]
    fn returns_only_the_current_owner_task_snapshot() {
        let mut cache = cache();
        cache.replace(&owner(), &[task()], FETCHED_AT).unwrap();
        let other = LarkTaskCacheOwner {
            user_id: "user-b".to_owned(),
            workspace_id: owner().workspace_id,
        };
        let task_b = CachedLarkTask {
            guid: "task-b".to_owned(),
            ..task()
        };
        cache
            .replace(&other, std::slice::from_ref(&task_b), FETCHED_AT)
            .unwrap();

        assert_eq!(cache.list(&owner()).unwrap(), vec![task()]);
        assert_eq!(cache.list(&other).unwrap(), vec![task_b]);
    }

    #[test]
    fn atomically_replaces_a_stale_snapshot() {
        let mut cache = cache();
        cache.replace(&owner(), &[task()], FETCHED_AT).unwrap();
        let next = CachedLarkTask {
            guid: "task-next".to_owned(),
            summary: "New task".to_owned(),
            ..task()
        };
        cache
            .replace(&owner(), std::slice::from_ref(&next), FETCHED_AT)
            .unwrap();

        assert_eq!(cache.list(&owner()).unwrap(), vec![next]);
    }
}

#[test]
fn a_failed_replace_leaves_the_previous_snapshot_in_place() {
    // Two tasks with one guid violate the primary key half way through the insert loop.
    let mut cache = cache();
    cache.replace(&owner(), &[task()], FETCHED_AT).unwrap();
    let twin = CachedLarkTask {
        guid: "dup".to_owned(),
        ..task()
    };
    let result = cache.replace(&owner(), &[twin.clone(), twin], FETCHED_AT);

    assert!(result.is_err());
    assert_eq!(cache.list(&owner()).unwrap(), vec![task()]);
    assert!(cache.has(&owner()).unwrap());
}
