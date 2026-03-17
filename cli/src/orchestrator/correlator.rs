use super::{EventGroup, RawEvent};

/// Group events by time proximity (events within `window_minutes` of each
/// other are placed in the same group). Groups are returned ordered by their
/// earliest event.
pub fn group_by_time(mut events: Vec<RawEvent>, window_minutes: i64) -> Vec<EventGroup> {
    if events.is_empty() {
        return vec![];
    }

    events.sort_by_key(|e| e.occurred_at);

    let mut groups: Vec<Vec<RawEvent>> = vec![];
    let mut current: Vec<RawEvent> = vec![events.remove(0)];

    for event in events {
        let last_time = current.last().unwrap().occurred_at;
        if (event.occurred_at - last_time).num_minutes().abs() <= window_minutes {
            current.push(event);
        } else {
            groups.push(current);
            current = vec![event];
        }
    }
    groups.push(current);

    groups
        .into_iter()
        .map(|events| {
            let severity = highest_severity(&events);
            EventGroup { events, severity }
        })
        .collect()
}

fn highest_severity(events: &[RawEvent]) -> String {
    if events.iter().any(|e| e.severity == "critical") {
        "critical".to_string()
    } else if events.iter().any(|e| e.severity == "warning") {
        "warning".to_string()
    } else {
        "info".to_string()
    }
}
