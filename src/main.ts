import * as core from '@actions/core'
import { context } from '@actions/github'
import type { components } from '@octokit/openapi-types'
import { newOctokitInstance } from './internal/octokit.js'

export type CheckSuite = components['schemas']['check-suite']
export type WorkflowRun = components['schemas']['workflow-run']
export type WorkflowRunStatus = components['parameters']['workflow-run-status']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', { required: true })
const ref = core.getInput('ref', { required: true })
const prNumber = parseInt(core.getInput('prNumber'))
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
        if (prNumber) {
            core.info(`Attempting to cancel running GitHub Actions for PR #${prNumber} at ref ${ref}`)
        } else {
            core.info(`Attempting to cancel running GitHub Actions for branch at ref ${ref}`)
        }

        log(`context`, context)

        const checkSuites = await octokit.paginate(octokit.checks.listSuitesForRef, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref,
        })

        await Promise.all(checkSuites.map(processCheckSuite))

    } catch (error) {
        core.setFailed(error instanceof Error ? error : `${error}`)
        throw error
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */


async function processCheckSuite(checkSuite: CheckSuite) {
    log(`checkSuite: ${checkSuite.id}: ${checkSuite.app?.slug}`, checkSuite)

    const checkSuitePrNumbers = checkSuite.pull_requests?.map(it => it.number) ?? []
    if (prNumber) {
        if (checkSuitePrNumbers.length === 0) {
            log(`Skipping GitHub Action check suite for a branch: ${checkSuite.url}`)
            return
        } else if (checkSuitePrNumbers.length === 1) {
            if (checkSuitePrNumbers[0] !== prNumber) {
                log(`Skipping GitHub Action check suite for another Pull Request: ${checkSuite.url}`)
                return
            }
        } else {
            log(`Skipping GitHub Action check suite for multiple Pull Requests: ${checkSuite.url}`)
            return
        }

    } else {
        if (checkSuitePrNumbers.length > 0) {
            log(`Skipping GitHub Action check suite for a Pull Request: ${checkSuite.url}`)
            return
        }
    }

    if (checkSuite.app?.slug !== 'github-actions') {
        log(`Skipping not a GitHub Actions check suite: ${checkSuite.url}`)
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


    const workflowRuns = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        check_suite_id: checkSuite.id,
        event: prNumber ? 'pull_request' : 'push',
    })
    await Promise.all(workflowRuns.map(processWorkflowRun))

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
}

function log(message: string, object: any = undefined) {
    const isDumpAvailable = true || core.isDebug()
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
    if (millis <= 0) {
        return Promise.resolve()
    }

    return new Promise((resolve) => {
        setTimeout(resolve, millis)
    })
}
