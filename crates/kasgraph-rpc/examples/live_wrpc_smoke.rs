use std::{env, time::Duration};

use kasgraph_rpc::{ChainNotification, MultiRpcClient, RpcClientConfig, RpcEndpoint};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = env::var("KASGRAPH_WRPC_URL")
        .unwrap_or_else(|_| "wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json".to_owned());
    let max_messages = env::var("KASGRAPH_WRPC_MAX_MESSAGES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4usize);
    let idle_timeout_ms = env::var("KASGRAPH_WRPC_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15_000u64);

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

    let notifications = client
        .read_notifications_ws(&url, "live-wrpc", max_messages, idle_timeout_ms)
        .await?;
    println!(
        "captured {} notifications from {} (max_messages={}, idle_timeout_ms={})",
        notifications.len(),
        url,
        max_messages,
        idle_timeout_ms
    );

    for (index, notification) in notifications.iter().enumerate() {
        match notification {
            ChainNotification::BlockAdded(block) => {
                println!(
                    "[{index}] BlockAdded hash={} daa={} blue={} finalized={} served_by={}",
                    block.hash,
                    block.daa_score,
                    block.blue_score,
                    block.is_finalized,
                    block.served_by
                );
            }
            ChainNotification::VirtualChainChanged {
                removed_chain_block_hashes,
                added_chain_blocks,
            } => {
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
            }
            ChainNotification::RecoveryRequired {
                from_daa_score,
                to_daa_score,
                reason,
            } => {
                println!(
                    "[{index}] RecoveryRequired from={} to={} reason={}",
                    from_daa_score, to_daa_score, reason
                );
            }
        }
    }

    Ok(())
}
