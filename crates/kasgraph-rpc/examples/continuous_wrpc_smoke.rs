use std::{
    env,
    fs::{self, File},
    io::{BufWriter, Write},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use kasgraph_rpc::{
    ChainNotification, MultiRpcClient, RpcClientConfig, RpcEndpoint, SubscriptionBackoff,
    SubscriptionDriverEvent,
};
use serde_json::json;
use tokio::sync::mpsc;

/// Append one NDJSON line stamped with a unix-ms timestamp. No-op
/// when no event log was requested. Errors are surfaced (a broken
/// trace makes the whole soak un-replayable, so we'd rather fail
/// fast than silently lose lines).
fn write_event_line(
    writer: &mut Option<BufWriter<File>>,
    mut payload: serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(writer) = writer else {
        return Ok(());
    };
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("ts_ms".to_owned(), serde_json::Value::from(ts_ms));
    }
    writeln!(writer, "{}", serde_json::to_string(&payload)?)?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = env::var("KASGRAPH_WRPC_URL")
        .unwrap_or_else(|_| "wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json".to_owned());
    let max_notifications = env::var("KASGRAPH_WRPC_MAX_MESSAGES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0usize);
    let duration_seconds = env::var("KASGRAPH_WRPC_DURATION_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60u64);
    let channel_capacity = env::var("KASGRAPH_WRPC_CHANNEL_CAPACITY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64usize);
    let summary_json_path = env::var("KASGRAPH_WRPC_SUMMARY_JSON")
        .ok()
        .map(PathBuf::from);
    let event_ndjson_path = env::var("KASGRAPH_WRPC_EVENT_NDJSON")
        .ok()
        .map(PathBuf::from);

    let mut event_writer = match event_ndjson_path.as_ref() {
        Some(path) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            Some(BufWriter::new(File::create(path)?))
        }
        None => None,
    };

    let client = MultiRpcClient::new(RpcClientConfig {
        primary: RpcEndpoint {
            label: "live-wrpc".to_owned(),
            url: url.clone(),
            timeout: Duration::from_secs(20),
        },
        backups: Vec::new(),
        health_probe_interval: Duration::from_secs(30),
    });

    let capabilities = client.probe_live_capabilities().await?;
    println!(
        "capabilities endpoint={} network={} serverVersion={} rpcApiVersion={} synced={} hasMessageId={} hasNotifyCommand={}",
        capabilities.endpoint,
        capabilities.server_info.network_id,
        capabilities.server_info.server_version,
        capabilities.server_info.rpc_api_version,
        capabilities.server_info.is_synced && capabilities.node_info.is_synced,
        capabilities.node_info.has_message_id,
        capabilities.node_info.has_notify_command,
    );

    let (sender, mut receiver) = mpsc::channel(channel_capacity);
    let (event_sender, mut event_receiver) = mpsc::channel(channel_capacity);
    let handle = client.spawn_continuous_subscription_with_events(
        url.clone(),
        "live-wrpc".to_owned(),
        sender,
        SubscriptionBackoff::default(),
        event_sender,
    );

    let started = Instant::now();
    let deadline = started + Duration::from_secs(duration_seconds);

    let mut block_added = 0usize;
    let mut virtual_chain_changed = 0usize;
    let mut recovery_required = 0usize;
    let mut reconnects = 0u64;
    let mut connections = 0u64;
    let mut highest_daa_seen: Option<u64> = None;
    let mut stop_reason: Option<String> = None;
    let mut observed_gap_ranges: Vec<(u64, u64)> = Vec::new();

    loop {
        if max_notifications != 0
            && block_added + virtual_chain_changed + recovery_required >= max_notifications
        {
            println!("stopping after max_notifications={max_notifications}");
            break;
        }

        let now = Instant::now();
        if now >= deadline {
            println!("stopping after duration_seconds={duration_seconds}");
            break;
        }
        let remaining = deadline.saturating_duration_since(now);

        tokio::select! {
            _ = tokio::time::sleep(remaining) => {
                println!("stopping after duration_seconds={duration_seconds}");
                break;
            }
            maybe_event = event_receiver.recv() => {
                let Some(event) = maybe_event else {
                    println!("driver event channel closed");
                    break;
                };
                match event {
                    SubscriptionDriverEvent::Connected { reconnect_count, .. } => {
                        connections += 1;
                        reconnects = reconnects.max(reconnect_count);
                        println!("[event] Connected reconnect_count={reconnect_count}");
                        write_event_line(&mut event_writer, json!({
                            "kind": "driver",
                            "event": "Connected",
                            "reconnect_count": reconnect_count,
                        }))?;
                    }
                    SubscriptionDriverEvent::ReconnectScheduled { reconnect_count, delay_ms, reason, last_emitted_daa, .. } => {
                        reconnects = reconnects.max(reconnect_count);
                        println!("[event] ReconnectScheduled reconnect_count={reconnect_count} delay_ms={delay_ms} last_emitted_daa={last_emitted_daa:?} reason={reason}");
                        write_event_line(&mut event_writer, json!({
                            "kind": "driver",
                            "event": "ReconnectScheduled",
                            "reconnect_count": reconnect_count,
                            "delay_ms": delay_ms,
                            "last_emitted_daa": last_emitted_daa,
                            "reason": reason,
                        }))?;
                    }
                    SubscriptionDriverEvent::GapDetected { reconnect_count, from_daa_score, to_daa_score, .. } => {
                        reconnects = reconnects.max(reconnect_count);
                        observed_gap_ranges.push((from_daa_score, to_daa_score));
                        println!("[event] GapDetected reconnect_count={reconnect_count} from={from_daa_score} to={to_daa_score}");
                        write_event_line(&mut event_writer, json!({
                            "kind": "driver",
                            "event": "GapDetected",
                            "reconnect_count": reconnect_count,
                            "from_daa_score": from_daa_score,
                            "to_daa_score": to_daa_score,
                        }))?;
                    }
                    SubscriptionDriverEvent::Stopped { reconnect_count, reason, last_emitted_daa, .. } => {
                        reconnects = reconnects.max(reconnect_count);
                        stop_reason = Some(reason.clone());
                        println!("[event] Stopped reconnect_count={reconnect_count} last_emitted_daa={last_emitted_daa:?} reason={reason}");
                        write_event_line(&mut event_writer, json!({
                            "kind": "driver",
                            "event": "Stopped",
                            "reconnect_count": reconnect_count,
                            "last_emitted_daa": last_emitted_daa,
                            "reason": reason,
                        }))?;
                    }
                }
            }
            maybe_notification = receiver.recv() => {
                let Some(notification) = maybe_notification else {
                    println!("driver notification channel closed");
                    break;
                };

                let index = block_added + virtual_chain_changed + recovery_required;
                match notification {
                    ChainNotification::BlockAdded(block) => {
                        block_added += 1;
                        highest_daa_seen = Some(highest_daa_seen.map_or(block.daa_score, |prev| prev.max(block.daa_score)));
                        println!(
                            "[{index}] BlockAdded hash={} daa={} blue={} finalized={} served_by={}",
                            block.hash,
                            block.daa_score,
                            block.blue_score,
                            block.is_finalized,
                            block.served_by
                        );
                        write_event_line(&mut event_writer, json!({
                            "kind": "notification",
                            "type": "BlockAdded",
                            "index": index,
                            "hash": block.hash,
                            "daa_score": block.daa_score,
                            "blue_score": block.blue_score,
                            "is_finalized": block.is_finalized,
                            "served_by": block.served_by,
                        }))?;
                    }
                    ChainNotification::VirtualChainChanged {
                        removed_chain_block_hashes,
                        added_chain_blocks,
                    } => {
                        virtual_chain_changed += 1;
                        if let Some(max_daa) = added_chain_blocks.iter().map(|b| b.daa_score).max() {
                            highest_daa_seen = Some(highest_daa_seen.map_or(max_daa, |prev| prev.max(max_daa)));
                        }
                        println!(
                            "[{index}] VirtualChainChanged removed={} added={}",
                            removed_chain_block_hashes.len(),
                            added_chain_blocks.len()
                        );
                        for block in added_chain_blocks.iter().take(3) {
                            println!(
                                "    + hash={} daa={} blue={} finalized={} served_by={}",
                                block.hash,
                                block.daa_score,
                                block.blue_score,
                                block.is_finalized,
                                block.served_by
                            );
                        }
                        write_event_line(&mut event_writer, json!({
                            "kind": "notification",
                            "type": "VirtualChainChanged",
                            "index": index,
                            "removed_count": removed_chain_block_hashes.len(),
                            "added_count": added_chain_blocks.len(),
                            "removed_hashes": removed_chain_block_hashes,
                            "added_blocks": added_chain_blocks.iter().map(|b| json!({
                                "hash": b.hash,
                                "daa_score": b.daa_score,
                                "blue_score": b.blue_score,
                                "is_finalized": b.is_finalized,
                                "served_by": b.served_by,
                            })).collect::<Vec<_>>(),
                        }))?;
                    }
                    ChainNotification::RecoveryRequired {
                        from_daa_score,
                        to_daa_score,
                        reason,
                    } => {
                        recovery_required += 1;
                        println!(
                            "[{index}] RecoveryRequired from={} to={} reason={}",
                            from_daa_score, to_daa_score, reason
                        );
                        write_event_line(&mut event_writer, json!({
                            "kind": "notification",
                            "type": "RecoveryRequired",
                            "index": index,
                            "from_daa_score": from_daa_score,
                            "to_daa_score": to_daa_score,
                            "reason": reason,
                        }))?;
                    }
                }
            }
        }
    }

    drop(receiver);
    drop(event_receiver);
    handle.await?;

    if let Some(mut writer) = event_writer.take() {
        writer.flush()?;
        if let Some(path) = event_ndjson_path.as_ref() {
            println!("wrote event_ndjson={}", path.display());
        }
    }

    let elapsed_seconds = started.elapsed().as_secs();
    let final_stop_reason =
        stop_reason.unwrap_or_else(|| "receiver closed by smoke runner".to_owned());

    println!(
        "summary duration_seconds={} blocks={} virtual_chain_changed={} recovery_required={} total={} highest_daa_seen={:?} reconnects={} connections={} stop_reason={}",
        elapsed_seconds,
        block_added,
        virtual_chain_changed,
        recovery_required,
        block_added + virtual_chain_changed + recovery_required,
        highest_daa_seen,
        reconnects,
        connections,
        final_stop_reason
    );

    if let Some(path) = summary_json_path {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let summary = json!({
            "url": url,
            "durationSeconds": elapsed_seconds,
            "requestedDurationSeconds": duration_seconds,
            "maxNotifications": max_notifications,
            "blockAdded": block_added,
            "virtualChainChanged": virtual_chain_changed,
            "recoveryRequired": recovery_required,
            "totalNotifications": block_added + virtual_chain_changed + recovery_required,
            "highestDaaSeen": highest_daa_seen,
            "reconnects": reconnects,
            "connections": connections,
            "stopReason": final_stop_reason,
            "gapRanges": observed_gap_ranges
                .iter()
                .map(|(from, to)| json!({"from": from, "to": to}))
                .collect::<Vec<_>>(),
            "capabilities": {
                "endpoint": capabilities.endpoint,
                "networkId": capabilities.server_info.network_id,
                "serverVersion": capabilities.server_info.server_version,
                "rpcApiVersion": capabilities.server_info.rpc_api_version,
                "rpcApiRevision": capabilities.server_info.rpc_api_revision,
                "isSynced": capabilities.server_info.is_synced && capabilities.node_info.is_synced,
                "hasMessageId": capabilities.node_info.has_message_id,
                "hasNotifyCommand": capabilities.node_info.has_notify_command
            }
        });
        fs::write(&path, serde_json::to_string_pretty(&summary)?)?;
        println!("wrote summary_json={}", path.display());
    }

    Ok(())
}
