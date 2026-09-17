use super::*;
use mindleak_memory::{
    DomainIdentity, DomainQuery, DomainWrite, EdgeProvenance, RelationshipDirection,
};

fn identity(namespace: &str, id: &str) -> DomainIdentity {
    DomainIdentity {
        namespace: namespace.into(),
        id: id.into(),
    }
}

fn entity(namespace: &str, id: &str) -> PreparedMemory {
    let mut entity = keyed_memory(namespace);
    entity.request.as_mut().unwrap().domain = Some(DomainWrite::Entity {
        identity: identity(namespace, id),
        label: id.into(),
        entity_type: "package".into(),
    });
    entity
}

fn edge(namespace: &str, id: &str) -> PreparedMemory {
    let mut edge = keyed_memory(namespace);
    edge.request.as_mut().unwrap().domain = Some(DomainWrite::Edge {
        identity: identity(namespace, id),
        source: identity(namespace, "source"),
        target: identity(namespace, "target"),
        predicate: "depends_on".into(),
        provenance: EdgeProvenance {
            source_references: vec!["fixture:directed-edge".into()],
            reported_confidence: Some(0.4),
        },
    });
    edge
}

#[tokio::test]
async fn concurrent_domain_identity_retries_share_one_committed_episode() {
    let (store, database) = setup().await;
    let namespace = format!("domain-concurrent-{}", Uuid::new_v4());
    let original = entity(&namespace, "source");
    let mut writes = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let mut attempt = original.clone();
        attempt.id = Uuid::new_v4();
        for fragment in &mut attempt.fragments {
            fragment.id = Uuid::new_v4();
        }
        let store = store.clone();
        writes.spawn(async move { store.save(&attempt).await });
    }
    let mut receipt = None;
    while let Some(result) = writes.join_next().await {
        let result = result.unwrap().unwrap();
        if let Some(receipt) = &receipt {
            assert_eq!(receipt, &result);
        } else {
            receipt = Some(result);
        }
    }
    let mut different_key = original.clone();
    different_key.id = Uuid::new_v4();
    different_key.request.as_mut().unwrap().request_id = Uuid::new_v4();
    assert!(store
        .save(&different_key)
        .await
        .unwrap_err()
        .is::<InvalidInput>());
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM public.memories WHERE agent_id = $1",
                &[&namespace]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM public.fragments WHERE memory_id = $1",
                &[&receipt.unwrap().memory_id]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        2
    );
}

#[tokio::test]
async fn domain_edge_readback_verifies_stored_direction_and_provenance() {
    let (store, database) = setup().await;
    let namespace = format!("edge-readback-{}", Uuid::new_v4());
    let source = entity(&namespace, "source");
    let target = entity(&namespace, "target");
    store.save(&source).await.unwrap();
    store.save(&target).await.unwrap();
    let entity_query = DomainQuery::Entity {
        identity: identity(&namespace, "source"),
        predicate: None,
        direction: None,
        after: None,
    };
    database.execute("UPDATE public.memories SET domain_entity = domain_entity || '{\"label\":\"changed\"}'::jsonb WHERE id = $1", &[&source.id]).await.unwrap();
    assert!(
        store
            .inspect_domain(&entity_query, &filter(None), 1)
            .await
            .is_err(),
        "Entity verification must check the indexed metadata, not only echo the request"
    );
    database
        .execute(
            "UPDATE public.memories SET domain_entity = request_payload->'domain' WHERE id = $1",
            &[&source.id],
        )
        .await
        .unwrap();
    let edge = edge(&namespace, "edge");
    store.save(&edge).await.unwrap();
    let query = DomainQuery::Edge {
        identity: identity(&namespace, "edge"),
    };
    assert_eq!(
        store
            .inspect_domain(&query, &filter(None), 1)
            .await
            .unwrap()
            .unwrap()
            .record
            .domain,
        edge.request.as_ref().unwrap().domain.clone().unwrap()
    );
    database.execute("UPDATE public.relationships SET source_entity = $1, target_entity = $2, predicate = 'different', provenance = '{\"sourceReferences\":[\"fixture:changed\"],\"reportedConfidence\":0.9}'::jsonb WHERE edge_memory_id = $3",
        &[&target.id, &source.id, &edge.id]).await.unwrap();
    assert!(
        store
            .inspect_domain(&query, &filter(None), 1)
            .await
            .is_err(),
        "Read-back must detect stored edges differing from the immutable source claim"
    );
}

#[tokio::test]
async fn unresolved_or_conflicting_domain_edges_roll_back_the_complete_episode() {
    let (store, database) = setup().await;
    let namespace = format!("edge-atomic-{}", Uuid::new_v4());
    store.save(&entity(&namespace, "source")).await.unwrap();
    let original = edge(&namespace, "edge");
    assert!(store
        .save(&original)
        .await
        .unwrap_err()
        .is::<InvalidInput>());
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM public.memories WHERE id = $1",
                &[&original.id]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    store.save(&entity(&namespace, "target")).await.unwrap();
    let receipt = store.save(&original).await.unwrap();
    let replacement = edge(&namespace, "edge");
    assert!(store
        .save(&replacement)
        .await
        .unwrap_err()
        .is::<InvalidInput>());
    assert_eq!(store.save(&original).await.unwrap(), receipt);
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM public.memories WHERE agent_id = $1",
                &[&namespace]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        3
    );
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM public.relationships WHERE domain_namespace = $1",
                &[&namespace]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );
}

#[tokio::test]
async fn domain_predicate_pages_preserve_every_edge_and_reject_cross_scope_writes() {
    let (store, database) = setup().await;
    let namespace = format!("domain-predicates-{}", Uuid::new_v4());
    store.save(&entity(&namespace, "source")).await.unwrap();
    store.save(&entity(&namespace, "target")).await.unwrap();
    let mut expected = std::collections::HashSet::new();
    for (index, predicate) in ["z-last", "a-first", "depends_on", "depends_on"]
        .into_iter()
        .enumerate()
    {
        let mut record = edge(&namespace, &format!("edge-{index}"));
        if let Some(DomainWrite::Edge {
            predicate: field, ..
        }) = record.request.as_mut().unwrap().domain.as_mut()
        {
            *field = predicate.into();
        }
        expected.insert(store.save(&record).await.unwrap().memory_id);
    }
    for direction in [
        RelationshipDirection::Outgoing,
        RelationshipDirection::Incoming,
    ] {
        let mut query = DomainQuery::Entity {
            identity: identity(
                &namespace,
                if direction == RelationshipDirection::Outgoing {
                    "source"
                } else {
                    "target"
                },
            ),
            predicate: None,
            direction: Some(direction),
            after: None,
        };
        let mut seen = std::collections::HashSet::new();
        loop {
            let page = store
                .inspect_domain(&query, &filter(None), 1)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(page.relationships.len(), 1);
            assert!(seen.insert(page.relationships[0].memory_id));
            let Some(cursor) = page.next_cursor else {
                break;
            };
            assert!(seen.len() < 5);
            if let DomainQuery::Entity { after, .. } = &mut query {
                *after = Some(cursor);
            }
        }
        assert_eq!(seen, expected);
    }
    let mut different_scope = entity(&namespace, "other-scope");
    different_scope.context.scope = Some("another-project".into());
    different_scope.request.as_mut().unwrap().context = different_scope.context.clone();
    store.save(&different_scope).await.unwrap();
    let mut cross_scope = edge(&namespace, "cross-scope");
    if let Some(DomainWrite::Edge { target, .. }) =
        cross_scope.request.as_mut().unwrap().domain.as_mut()
    {
        *target = identity(&namespace, "other-scope");
    }
    assert!(store
        .save(&cross_scope)
        .await
        .unwrap_err()
        .is::<InvalidInput>());
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM public.memories WHERE id = $1",
                &[&cross_scope.id]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
        0
    );
}

#[tokio::test]
async fn domain_pages_advance_over_filtered_edges_and_respect_the_byte_budget() {
    let (store, database) = setup().await;
    let namespace = format!("edge-pages-{}", Uuid::new_v4());
    store.save(&entity(&namespace, "source")).await.unwrap();
    store.save(&entity(&namespace, "target")).await.unwrap();
    let prefix = Uuid::new_v4().as_u128() & !0xffff;
    for index in 0..140 {
        let mut edge = edge(&namespace, &format!("edge-{index}"));
        edge.id = Uuid::from_u128(prefix + index + 1);
        if index < 128 {
            edge.agent_id = format!("other-{namespace}");
            edge.request.as_mut().unwrap().agent_id = edge.agent_id.clone();
        } else {
            edge.raw_text = "\"".repeat(32768);
            edge.request.as_mut().unwrap().text = edge.raw_text.clone();
        }
        store.save(&edge).await.unwrap();
    }
    let mut query = DomainQuery::Entity {
        identity: identity(&namespace, "source"),
        predicate: Some("depends_on".into()),
        direction: Some(RelationshipDirection::Outgoing),
        after: None,
    };
    let first = store
        .inspect_domain(&query, &filter(Some(&namespace)), 50)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.scanned_relationships, 128);
    assert!(first.relationships.is_empty() && first.next_cursor.is_some());
    let mut cursor = first.next_cursor;
    let mut seen = std::collections::HashSet::new();
    let mut pages = 0;
    while let Some(after) = cursor {
        pages += 1;
        assert!(pages <= 4);
        if let DomainQuery::Entity { after: field, .. } = &mut query {
            *field = Some(after);
        }
        let page = store
            .inspect_domain(&query, &filter(Some(&namespace)), 50)
            .await
            .unwrap()
            .unwrap();
        assert!(
            serde_json::to_vec(&page).unwrap().len() <= mindleak_memory::MAX_RECALL_RESULT_BYTES
        );
        for record in &page.relationships {
            assert!(seen.insert(record.memory_id));
        }
        cursor = page.next_cursor;
    }
    assert_eq!(seen.len(), 12);
    assert!(
        pages >= 2,
        "Large exact source records must split into byte-bounded pages"
    );
    assert_eq!(database.query_one("SELECT sum(confirmed_sessions + useful_sessions) FROM public.fragments WHERE memory_id IN (SELECT id FROM public.memories WHERE agent_id = $1)", &[&namespace]).await.unwrap().get::<_, i64>(0), 0);
}
