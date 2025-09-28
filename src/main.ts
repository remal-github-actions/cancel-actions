import * as core from '@actions/core'
import { context } from '@actions/github'
import type { components } from '@octokit/openapi-types'
import { newOctokitInstance } from './internal/octokit.js'

export type CheckSuite = components['schemas']['check-suite']
export type WorkflowRun = components['schemas']['workflow-run']
export type WorkflowRunStatus = components['parameters']['workflow-run-status']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', { required: true })
const dryRun = core.getInput('dryRun').toLowerCase() === 'true'

const octokit = newOctokitInstance(githubToken)

const statusesToFind: WorkflowRunStatus[] = [
    'action_required',
    'stale',
    'in_progress',
    'queued',
    'requested',
    'waiting',
    'pending',
]

const checkSuiteCreationDelayMillis = 0

const cancelAttempts = 5
const cancelRetryDelayMillis = 5_000

const now = Date.now()

async function run(): Promise<void> {
    try {
        log(`context`, context)

        let commitSha: string | undefined = undefined
        if (context.eventName === 'pull_request') {
            const pullRequest = context.payload.pull_request!
            log(`pullRequest: #${pullRequest?.number}`, pullRequest)
            commitSha = pullRequest?.head?.sha
        } else if (context.eventName === 'delete') {
            commitSha = context.sha
        } else {
            log(`Unsupported event: ${context.eventName}`)
            return
        }

        if (commitSha == null) {
            core.warning(`Commit SHA couldn't be detected.`)
            return
        }

        log(`Commit SHA: ${commitSha}`)

        const checkSuites = await octokit.paginate(octokit.checks.listSuitesForRef, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref: commitSha,
        })

        await Promise.all(checkSuites.map(checkSuite =>
            processCheckSuite(commitSha, checkSuite),
        ))

    } catch (error) {
        core.setFailed(error instanceof Error ? error : `${error}`)
        throw error
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */


async function processCheckSuite(expectedCommitSha: string, checkSuite: CheckSuite) {
    log(`checkSuite: ${checkSuite.id}: ${checkSuite.app?.slug}`, checkSuite)
    if (checkSuite.app?.slug !== 'github-actions') {
        log(`Skipping not a GitHub Actions check suite: ${checkSuite.url}`)
        return
    }

    if (checkSuite.head_commit.id !== expectedCommitSha) {
        log(`Skipping GitHub Action for another commit: ${checkSuite.url}`)
        return
    }

    if (checkSuite.status != null && !statusesToFind.includes(checkSuite.status)) {
        log(`Skipping completed GitHub Action check suite: ${checkSuite.url}: ${checkSuite.status}`)
        return
    }

    if (checkSuite.created_at?.length) {
        const createdAt = new Date(checkSuite.created_at).getTime()
        const delayMillis = createdAt - (now - checkSuiteCreationDelayMillis)
        if (delayMillis > 0) {
            log(`delayMillis`, delayMillis)
            await sleep(delayMillis)
        }
    }


    async function processWorkflowRun(workflowRun: WorkflowRun, attempt: number = 1) {
        if (attempt > 1) {
            workflowRun = await octokit.actions.getWorkflowRun({
                owner: context.repo.owner,
                repo: context.repo.repo,
                run_id: workflowRun.id,
            }).then(it => it.data)
        }
        log(`workflowRun: ${workflowRun.id} (attempt ${attempt})`, workflowRun)

        if (workflowRun.id === context.runId) {
            log(`Skipping current workflow run: ${workflowRun.url}`)
            return
        }

        if (!statusesToFind.includes(workflowRun.status as WorkflowRunStatus)) {
            log(`Skipping workflow run: ${workflowRun.url}: ${workflowRun.status}`)
            return
        }

        try {
            if (attempt > cancelAttempts) {
                core.warning(`Forcefully canceling workflow run: ${workflowRun.url} (attempt ${attempt})`)
                if (dryRun) {
                    return
                }

                await octokit.actions.forceCancelWorkflowRun({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    run_id: workflowRun.id,
                })
                return
            }

            core.warning(`Canceling workflow run: ${workflowRun.url} (attempt ${attempt})`)
            if (dryRun) {
                return
            }

            await octokit.actions.cancelWorkflowRun({
                owner: context.repo.owner,
                repo: context.repo.repo,
                run_id: workflowRun.id,
            })
        } catch (e) {
            core.error(e instanceof Error ? e.message : `${e}`)
        }

        await sleep(cancelRetryDelayMillis)
        return processWorkflowRun(workflowRun, attempt + 1)
    }

    const workflowRuns = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        check_suite_id: checkSuite.id,
        event: 'pull_request',
    })
    await Promise.all(workflowRuns.map(it => processWorkflowRun(it)))
}

function log(message: string, object: any = undefined) {
    const isDumpAvailable = core.isDebug()
    if (!isDumpAvailable) {
        return
    }

    if (object === undefined) {
        core.info(message)
        return
    }

    core.startGroup(message)
    core.info(JSON.stringify(
        object,
        (key, value) =>
            [
                '_links',
                'repository',
                'head_repository',
                'repo',
                'user',
                'owner',
                'organization',
                'sender',
                'actor',
                'triggering_actor',
                'body',
                'labels',
                'assignee',
                'assignees',
                'requested_reviewers',
                'events',
                'permissions',
            ].includes(key)
                ? null
                : value,
        2,
    ))
    core.endGroup()
}

function sleep(millis: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, millis)
    })
}
