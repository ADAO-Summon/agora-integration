import { PrismaClient } from '@prisma/client';
import fastify, { FastifyLoggerInstance, FastifyRequest } from 'fastify'
import fastifyOAS from 'fastify-oas'
import Bottleneck from 'bottleneck'
import dotenv from 'dotenv'
import { OutRef } from 'lucid-cardano'
import { createGovernorEndpoint, getGovernorData } from './txEndpoints/governorEndpoints.js'
import { createProposalEndpoint, advanceProposalEndpoint, getCommunityProposals, getProposalPageInfo, createProposalPreconfiguredEndpoint } from './txEndpoints/proposalEndpoints.js'
import { createStakeEndpoint, updateStakeEndpoint, delegateStakeEndpoint, destroyStakeEndpoint, cosignEndpoint, voteEndpoint, revokeVoteEndpoint, getAllUserStakes } from './txEndpoints/stakeEndpoints.js'
import { RouteGenericInterface } from 'fastify/types/route.js';
import { IncomingMessage, Server } from 'http';
import jwt from 'jsonwebtoken';
import { deployReferenceUtxo } from './txEndpoints/daoSelection.js';
import { SERVICES } from './constants.js';
import { mutateGovernorEndpoint, spendFromTreasuryEndpoint } from './txEndpoints/effectEndpoints.js';
dotenv.config()

//IMPORTANT FOR NFT MINT OR FT CLAIMS:
//IF PARALLEL REQUESTS ARE COMING IN, VALIDATE ONE BY ONE (no double-mints or double-claims)
const limiter = new Bottleneck({
    maxConcurrent: 1
})

let freeEndpoints: string[];

async function loadFreeEndpoints() {
    try {
        const config: any = await import('../../freeEndpoints.mjs');
        freeEndpoints = config.freeEndpoints;
    } catch (error) {
        console.log(error)
        console.error('Configuration file not found. Using default values.');
        freeEndpoints = [];
    }

    console.log(freeEndpoints);
}

loadFreeEndpoints();

const PORT = process.env.SERVICE_PORT
const AUTH = process.env.AUTH_ENDPOINT

if (!PORT) {
    throw 'Environment variables not set'
}

type ProposalPage = {
    name: string;
    proposalId: string;
    statusString: string;
    amountOfCosigners: string;
    cosignerUtxos: OutRef[];
    amountCosigned: string;
    deserializedEffects: Record<string, Record<string, [arg0: string, arg1: string | undefined]>>;
    deserializedVotes: Record<string, string>;
    deserializedThresholds: [string, string, string, string, string];
    deserializedTimingConfig: [string, string, string, string, string, string] // [Date, Date, Date, Date, Date, Date];
    startingTimeDate: string//Date;
}

type SignedRequest = {
    cose_signature_hex: String,
    cose_key_hex: String,
    expected_message: String,
    expected_address_bech32: String,
}

type UserClaim = {
    user_id: string,
    scope: string,
}

interface AuthenticatedRequest extends FastifyRequest<RouteGenericInterface, Server, IncomingMessage, unknown, FastifyLoggerInstance> {
    user?: UserClaim
}

const server = fastify()
const prisma = new PrismaClient();

interface Claims {
    sub: string;
    exp: number;
    token_type: string;
    scope: string;
    client: string;
}

export async function decodeJWTDeprecated(authHeader: string): Promise<Claims | null> {
    const token = authHeader.replace('Bearer ', '');

    const publicKey = `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0PZhKqd6ZpJG4CHJcr6F\niUfGQMKtogczKlaBUCuVjf2UJt7h+A2vPbWB5rxfea+TDVkjppTYAqXL6J1V2npW\nNl2MzO94meou8TUk+tFzLGfNGbRCeGhNSGhqXwtRyJoVqUHC25sLlXv9iy9j44dg\nc70bSZd54aEzNcpd9doPgSkwqSaZt8RwHp8e55A2J9J9lReYdt/xObECTVswpl4u\ndbayvzZIdDH5giFjSJ8jfwErkb6wM1kgAjHcdjQGCjMxy0yYa5HLhAmYOKen3mcA\nZy/W9HIhKioASxpfvNN4ZxKD2qVOv1tP9P3i8IzLbAMi7zPbA9TT6BGDPKe2Q0z/\nnQIDAQAB\n-----END PUBLIC KEY-----\n`

    try {
        const decodedClaims = jwt.verify(token, publicKey) as Claims;
        return decodedClaims;
    } catch (error) {
        console.error('Error decoding JWT:', error);
        return null;
    }
}

export async function decodeJWT(authHeader: string): Promise<Claims | null> {
    const token = authHeader.replace('Bearer ', '');

    const publicKey = process.env.PUBLIC_KEY as string;

    try {
        const decodedClaims = jwt.verify(token, publicKey, {
            ignoreExpiration: true
        }) as Claims;

        return decodedClaims;
    } catch (error) {
        console.error('Error decoding JWT:', error);
        return null;
    }
}

export const handleFees = async (subject: string, id: string, endpointName: string) => {

    try {
        const url = `${SERVICES.ESCROW_SERVICE}/checkfees/data-layer/${endpointName}/${subject}/${id}`
        console.log(url)
        const res = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.SUMMON_JWT}`,
            }
        });
        if (res.status !== 200) throw "Invalid client id";

        const isEnoughBalance = await res.text()
        console.log({ isEnoughBalance })
        if (isEnoughBalance === "true") {
            return isEnoughBalance
        } else {
            throw new Error("Error retrieving balance");
        }
    } catch (e) {
        console.log(e)
        throw new Error("Insufficient balance");
    }
}

server.addHook('preHandler', async (request: AuthenticatedRequest, reply) => {
    const authHeader = request.headers["authorization"]
    const method = request.method.toLowerCase()
    const endpoint = request.url.split('/')[1].split('?')[0]

    if (!authHeader) throw "No auth header"
    if (authHeader.startsWith("Bearer")) {
        const decodedClaims = await decodeJWT(authHeader);

        if (!decodedClaims) throw "We couldn't verify auth header"

        // if (decodedClaims.exp < Date.now() / 1000) throw "Token expired"
        if (decodedClaims.exp === 0) //API key
        {
            const queryParams = {
                access_token: authHeader.replace('Bearer ', '')
            };

            const url = `${SERVICES.APIKEYS_SERVICE}/verifyAccessToken?${new URLSearchParams(queryParams)}`;

            const resp = await fetch(url, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (resp.status === 429) throw "Rate limit reached";
            else if (resp.status !== 200) throw "Invalid API key";
            request.user = { user_id: decodedClaims.sub, scope: decodedClaims.scope }
            return

        }

        else if (decodedClaims.exp < Date.now() / 1000) throw "Token expired"

        if (decodedClaims.client !== "summon") // check active projects for tokens issued by 3rd parties
        {
            const url = `${SERVICES.APIKEYS_SERVICE}/verifyClientId/${decodedClaims.client}`;
            const resp = await fetch(url, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.SUMMON_JWT}`,
                }
            });
            if (resp.status !== 200) throw "Invalid client id";
        }

        request.user = { user_id: decodedClaims.sub, scope: decodedClaims.scope }
    } else {
        throw "Auth header needs to include Bearer token"
    }
    if (freeEndpoints.length == 0 || !freeEndpoints.includes(`${method}:${endpoint}`)) {
        await handleFees("user", request.user.user_id, `${method}:${endpoint}`)
    }
})

server.addHook('onResponse', async (request: AuthenticatedRequest, reply) => {
    console.log("onResponse")
    console.log(reply.statusCode)
    if (reply.statusCode === 200) {
        const method = request.method.toLowerCase()
        const endpoint = request.url.split('/')[1].split('?')[0]
        if (freeEndpoints.length == 0 || !freeEndpoints.includes(`${method}:${endpoint}`)) {

            const userId = request.user?.user_id
            if (!userId) throw "No user id"

            const url = `${SERVICES.ESCROW_SERVICE}/account/payment/create`; // Replace with your actual server URL
            const body = {
                subject: "user",
                subject_id: userId,
                service_name: "data-layer",
                endpoint_name: `${method}:${endpoint}`,
                //value: 100,
                reason: `${method}:${endpoint}`
            };

            fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.SUMMON_JWT}`,
                },
                body: JSON.stringify(body)
            })
        }
    }
})

const handleScopes = (request: AuthenticatedRequest, requiredScopes: string[]) => {
    console.log('requiredScopes', requiredScopes)
    console.log('request.user.scope', request.user?.scope)
    if (!requiredScopes) throw "No required scopes";
    // Create a variable that is a copy of request.user!.scope
    // Stored as a list of strings by splitting up the original string by spaces
    const userScopes = request.user!.scope.split(' ');
    // Check if there is at least one element from the required scopes present in the new list of strings
    if (requiredScopes && (!request.user || !requiredScopes.some((scope: string) => userScopes.includes(scope)))) {
        throw "Insufficient scope";
    }
}

if (process.env.ENVIRONMENT != "production") {
    server.register(import('@fastify/cors'),
        (instance) =>
            (req: any, callback: any) => {
                const corsOptions = {
                    // This is NOT recommended for production as it enables reflection exploits
                    origin: true
                };

                // do not include CORS headers for requests from localhost
                if (/^localhost$/m.test(req.headers.origin)) {
                    corsOptions.origin = false
                }

                // callback expects two parameters: error and options
                callback(null, corsOptions)
            }
    )

    server.register(fastifyOAS, {
        routePrefix: '/documentation',
        swagger: {
            info: {
                title: 'agora-integration API',
                description: 'API documentation',
                version: '1.0.0',
            },
            tags: [
                {
                    name: 'agora-integration',
                    description: 'Operations related to Agora DAOs and their transactions.'
                },
            ],
            components: {
                securitySchemes: {
                    bearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT',
                    },
                },
            },
            paths: {},
        },
        exposeRoute: true,
    });
}

server.listen({ port: Number(PORT), host: '0.0.0.0' }, (err, address) => {
    if (err) {
        console.log("error")
        console.error(err)
    }
    console.log(`Server listening at ${address}`)
})

server.post('/postReference', {
    schema: {
        body: {
            type: 'object',
            properties: {
                communityId: { type: 'string', description: 'Community ID' },
                type: { type: 'string', description: 'Type' },
                address: { type: 'string', description: 'Address' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'Array of UTXOs'
                }
            },
            required: ['communityId', 'type', 'address', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /postReference")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => deployReferenceUtxo(prisma, body))
        console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/createDAO', {
    schema: {
        body: {
            type: 'object',
            description: 'CreateGovernorBody',
            examples: [
                {
                    name: 'CreateGovernorBody Sample',
                    summary: 'an example',
                    value: {
                        communityId: "1",
                        address: "addr1lolthisisnotarealaddressthough",
                        govTokenPolicy: "policy1",
                        govTokenName: "token1",
                        thresholds: [1, 2, 3, 4, 5],
                        timingConfig: ["2022-12-31T23:59:59Z", "2023-01-31T23:59:59Z", "2023-02-28T23:59:59Z", "2023-03-31T23:59:59Z", "2023-04-30T23:59:59Z", "2023-05-31T23:59:59Z"],
                        maxWidth: "2022-12-31T23:59:59Z",
                        maxProposalsPerStake: 25,
                        maximumCosigners: 5,
                        utxos: [{ txHash: "txHash1", outputIndex: 0 }, { txHash: "txHash2", outputIndex: 1 }]
                    },
                }
            ],
            properties: {
                communityId: { type: 'string', description: 'Community ID' },
                address: { type: 'string', description: 'Address of the SummonUser who is going to sign the transaction' },
                govTokenPolicy: { type: 'string', description: 'Governance token policy' },
                govTokenName: { type: 'string', description: 'Governance token name' },
                thresholds: { type: 'array', items: { type: 'number' }, description: 'Agora governable parameters' },
                timingConfig: { type: 'array', items: { type: 'string', format: 'date-time' }, description: 'Agora governable parameters' },
                maxWidth: { type: 'string', format: 'date-time', description: 'Agora governable parameters' },
                maxProposalsPerStake: { type: 'number', description: 'Agora governable parameters' },
                maximumCosigners: { type: 'number', description: 'Maximum number of cosigners' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'Array of UTXOs'
                }
            },
            required: ['address', 'govTokenPolicy', 'govTokenName', 'thresholds', 'timingConfig', 'maxWidth', 'maxProposalsPerStake', 'maximumCosigners', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    tx: { type: 'string', description: 'Transaction' },
                    communityId: { type: 'string', description: 'Community ID' },
                },
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered createDAO")
        const userId = request.user?.user_id
        const authHeader = request.headers["authorization"]
        if (!userId || !authHeader) throw "The user or auth is not valid"
        console.log(`Entered /createDAO`)
        const body: any = request.body
        console.log('bodyOriginal', body)
        const resp = await limiter.schedule(() => createGovernorEndpoint(prisma, userId, authHeader, body))
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/getDaoInfo', {
    schema: {
        body: {
            type: 'object',
            properties: {
                communityId: { type: 'string', description: 'Community ID' }
            },
            required: ['communityId'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['read:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    scriptParams: {
                        type: 'object',
                        properties: {
                            gstOutRef: {
                                type: 'object',
                                properties: {
                                    txOutRefId: { type: 'string', description: 'Transaction Out Reference ID' },
                                    txOutRefIdx: { type: 'number', description: 'Transaction Out Reference Index' }
                                },
                                required: ['txOutRefId', 'txOutRefIdx']
                            },
                            gtClassRef: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Governance Token Class Reference'
                            },
                            maximumCosigners: { type: 'number', description: 'Maximum Cosigners' }
                        }
                    },
                    thresholds: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of Thresholds'
                    },
                    nextProposalId: { type: 'string', description: 'Next Proposal ID' },
                    proposalTiming: {
                        type: 'array',
                        items: { type: 'string', format: 'date-time' },
                        description: 'Array of Proposal Timing'
                    },
                    proposalTxMaxLength: { type: 'string', description: 'Proposal Transaction Max Length' },
                    proposalsPerStake: { type: 'string', description: 'Proposals Per Stake' },
                    authTokenPolicy: { type: 'string', description: 'Authority Token Policy' }
                }
            }
        }
    }
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['read:public', 'platform:full'])
        console.log("Entered getDaoInfo")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => getGovernorData(prisma, body.communityId))
        console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/getCommunityProposals', {
    schema: {
        body: {
            type: 'object',
            properties: {
                communityId: { type: 'string', description: 'Community ID' }
            },
            required: ['communityId'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['read:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        txHash: { type: 'string', description: 'Transaction Hash' },
                        outputIndex: { type: 'string', description: 'Output Index' },
                        datum: { type: 'string', description: 'Datum' },
                        datumProcessed: {
                            type: 'object',
                            properties: {
                                proposalId: { type: 'string', description: 'Proposal ID' },
                                statusString: { type: 'string', description: 'Status String' },
                                amountOfCosigners: { type: 'string', description: 'Amount of Cosigners' },
                                amountCosigned: { type: 'string', description: 'Amount Cosigned' },
                                startingTimeDate: { type: 'string', description: 'Starting Time Date' }
                            }
                        },
                        name: { type: 'string', description: 'Proposal Name' },
                        description: { type: 'string', description: 'Proposal Description' },
                        discussionUrl: { type: 'string', description: 'Discussion URL' }
                    }
                }
            }
        }
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['read:public', 'platform:full'])
        console.log("Entered getCommunityProposals")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => getCommunityProposals(prisma, body.communityId))
        // console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/getProposalPageInfo', {
    schema: {
        body: {
            type: 'object',
            properties: {
                communityId: { type: 'string', description: 'Community ID' },
                proposalId: { type: 'string', description: 'Proposal ID' }
            },
            required: ['communityId', 'proposalId'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['read:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    proposalId: { type: 'string', description: 'Proposal ID' },
                    utxo: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    name: { type: 'string', description: 'Proposal Name' },
                    description: { type: 'string', description: 'Proposal Description' },
                    discussion_url: { type: 'string', description: 'Discussion URL' },
                    statusString: { type: 'string', description: 'Status String' },
                    amountOfCosigners: { type: 'string', description: 'Amount of Cosigners' },
                    cosignerUtxos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                txHash: { type: 'string', description: 'Transaction Hash' },
                                outputIndex: { type: 'number', description: 'Output Index' }
                            },
                            required: ['txHash', 'outputIndex']
                        },
                        description: 'Array of Cosigner UTXOs'
                    },
                    amountCosigned: { type: 'string', description: 'Amount Cosigned' },
                    deserializedEffects: {
                        type: 'object',
                        additionalProperties: {
                            type: 'object',
                            additionalProperties: {
                                type: 'array',
                                items: { type: ['string', 'null'] }
                            }
                        }
                    },
                    deserializedVotes: {
                        type: 'object',
                        additionalProperties: { type: 'string' }
                    },
                    deserializedThresholds: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    deserializedTimingConfig: {
                        type: 'array',
                        items: { type: 'string', format: 'date-time' }
                    },
                    startingTimeDate: { type: 'string', format: 'date-time' },
                    allEffects: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'ID' },
                                result: { type: 'string', description: 'Result' },
                                effect: { type: 'string', description: 'Effect' },
                                pool_id: { type: 'object', description: 'Pool ID' },
                                manager_input: { type: 'object', description: 'Manager Input' },
                                proposal_id: { type: 'string', description: 'Proposal ID' },
                                effect_index: { type: 'string', description: 'Effect Index' },
                                treasuries: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'string', description: 'ID' },
                                            effect_info_id: { type: 'string', description: 'Effect Info ID' },
                                            treasury: { type: 'string', description: 'Treasury' }
                                        },
                                        required: ['id', 'effect_info_id', 'treasury']
                                    },
                                    description: 'Array of Treasuries'
                                },
                                receivers: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'string', description: 'ID' },
                                            effect_info_id: { type: 'string', description: 'Effect Info ID' },
                                            receiver: { type: 'string', description: 'Receiver' },
                                            assets: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        id: { type: 'string', description: 'ID' },
                                                        receiver_id: { type: 'string', description: 'Receiver ID' },
                                                        asset_unit: { type: 'string', description: 'Asset Unit' },
                                                        value: { type: 'string', description: 'Value' }
                                                    },
                                                    required: ['id', 'receiver_id', 'asset_unit', 'value']
                                                },
                                                description: 'Array of Assets'
                                            }
                                        },
                                        required: ['id', 'effect_info_id', 'receiver']
                                    },
                                    description: 'Array of Receivers'
                                },
                                governor_input: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'string', description: 'ID' },
                                            create_max_width: { type: 'string', description: 'Create Max Width' },
                                            proposals_per_stake: { type: 'string', description: 'Proposals Per Stake' },
                                            effect_info_id: { type: 'string', description: 'Effect Info ID' }
                                        },
                                        required: ['id', 'create_max_width', 'proposals_per_stake', 'effect_info_id']
                                    },
                                    description: 'Array of Governor Input'
                                }
                            },
                        }
                    }
                }
            }
        }
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['read:public', 'platform:full'])
        console.log("Entered getProposalPageInfo")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        let resp: ProposalPage = await limiter.schedule(() => getProposalPageInfo(prisma, body.communityId, body.proposalId))

        function serializeComplexObject(obj: any): any {
            if (Array.isArray(obj)) {
                return obj.map(item => serializeComplexObject(item));
            }
            if (obj instanceof Date) {
                return obj.toISOString();
            }
            if (typeof obj === 'object') {
                const newObj: any = {};
                for (const key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        newObj[key] = serializeComplexObject(obj[key]);
                    }
                }
                return newObj;
            }
            if (typeof obj === 'bigint') {
                return obj.toString();
            }
            return obj;
        }

        // Serialize complex objects
        resp = serializeComplexObject(resp);

        console.log('Final response before sending:', JSON.stringify(resp, null, 2));

        return resp;
    } catch (e) {
        console.log(e)
        throw e
    }
})


server.post('/createProposal', {
    schema: {
        body: {
            type: 'object',
            properties: {
                displayName: { type: 'string', description: 'Display Name of the Proposal' },
                description: { type: 'string', description: 'Description of the Proposal' },
                discussionUrl: { type: ['string', 'null'], description: 'Discussion URL of the Proposal' },
                address: { type: 'string', description: 'Address of the Proposal Creator' },
                communityId: { type: 'string', description: 'Community ID' },
                effectScripts: { type: 'object', description: 'Effect Scripts of the Proposal' },
                stakeTxHash: { type: 'string', description: 'Stake Transaction Hash' },
                stakeIndex: { type: 'number', description: 'Stake Index' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'Array of UTXOs'
                }
            },
            required: ['displayName', 'description', 'discussionUrl', 'address', 'communityId', 'effectScripts', 'stakeTxHash', 'stakeIndex', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /createProposal")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        if (body.dbEffects) throw "dbEffects is not a valid parameter."
        const resp = await limiter.schedule(() => createProposalEndpoint(prisma, userId, body))
        console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/createProposalPreconfigured', {
    schema: {
        body: {
            type: 'object',
            properties: {
                displayName: { type: 'string', description: 'Display Name of the Proposal' },
                description: { type: 'string', description: 'Description of the Proposal' },
                discussionUrl: { type: ['string', 'null'], description: 'Discussion URL of the Proposal' },
                address: { type: 'string', description: 'Address of the Proposal Creator' },
                communityId: { type: 'string', description: 'Community ID' },
                effectInfo: {
                    type: 'array',
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                effect: { type: 'string', enum: ["Spend", "Register", "Delegate", "Withdraw", "EditDAO", "UpdateManager"], description: 'Effect of the Proposal' },
                                treasuries: { type: 'array', items: { type: 'string' }, description: 'Treasuries of the Proposal' },
                                receivers: {
                                    type: 'array',
                                    items: {
                                        type: 'array',
                                        items: [
                                            { type: 'string' },
                                            { type: 'object', additionalProperties: { type: 'string' } }
                                        ]
                                    },
                                    description: 'Receivers of the Proposal'
                                },
                                poolId: { type: ['string', 'null'], description: 'Pool ID of the Proposal' },
                                config: {
                                    type: ['object', 'null'],
                                    properties: {
                                        thresholds: { type: 'array', items: { type: 'number' }, description: 'Thresholds of the Proposal' },
                                        timingConfig: { type: 'array', items: { type: 'string', format: 'date-time' }, description: 'Timing Config of the Proposal' },
                                    },
                                    description: 'Config of the Proposal'
                                },
                                managerInput: { type: ['string', 'null'], description: 'Manager Input of the Proposal' }
                            },
                            required: ['effect']
                        },
                    },
                    description: 'Effect Info of the Proposal'
                },
                stakeTxHash: { type: 'string', description: 'Stake Transaction Hash' },
                stakeIndex: { type: 'number', description: 'Stake Index' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'Array of UTXOs'
                }
            },
            required: ['displayName', 'description', 'discussionUrl', 'address', 'communityId', 'effectInfo', 'stakeTxHash', 'stakeIndex', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /createProposalPreconfigured")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        if (body.dbEffects) throw "dbEffects is not a valid parameter."
        const resp = await limiter.schedule(() => createProposalPreconfiguredEndpoint(prisma, userId, body))
        console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/advanceProposal', {
    schema: {
        body: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'Address of the Proposal Creator' },
                communityId: { type: 'string', description: 'Community ID' },
                propId: { type: 'string', description: 'Proposal ID' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'Array of UTXOs'
                }
            },
            required: ['address', 'communityId', 'propId', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /advanceProposal")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => advanceProposalEndpoint(prisma, body))
        console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/getUserStakes', {
    schema: {
        body: {
            type: 'object',
            properties: {
                communityId: { type: 'string', description: 'Community ID' },
                addresses: { type: 'array', items: { type: 'string' }, description: 'Array of addresses' }
            },
            required: ['communityId', 'addresses'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['read:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    userClaimedStakeUtxos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                txHash: { type: 'string', description: 'Transaction Hash' },
                                outputIndex: { type: 'number', description: 'Output Index' },
                                relation: { type: 'string', description: 'Relation' },
                                delegated: { type: 'boolean', description: 'Delegated' },
                                amount: { type: 'string', description: 'Amount' },
                                locks: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            propId: { type: 'string', description: 'Prop ID' },
                                            propLock: { type: 'string', description: 'Prop Lock' }
                                        },
                                        required: ['propId', 'propLock']
                                    },
                                    description: 'Array of Locks'
                                }
                            },
                            required: ['txHash', 'outputIndex', 'relation', 'delegated', 'amount', 'locks']
                        },
                        description: 'Array of User Claimed Stake UTXOs'
                    },
                    stakedAmountString: { type: 'string', description: 'Staked Amount String' }
                }
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['read:public', 'platform:full'])
        console.log("Entered getUserStakes")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => getAllUserStakes(prisma, body.communityId, body.addresses))
        // console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/createStake', {
    schema: {
        body: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'User CIP-30 Address' },
                communityId: { type: 'string', description: 'Summon Platform CommunityId' },
                amount: { type: 'string', description: 'Amount of GT to stake' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'User Wallet UTxOs'
                }
            },
            required: ['address', 'communityId', 'amount', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /createStake")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => createStakeEndpoint(prisma, body))
        console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/updateStake', {
    schema: {
        body: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'User CIP-30 Address' },
                communityId: { type: 'string', description: 'Summon Platform CommunityId' },
                utxo: {
                    type: 'object',
                    properties: {
                        txHash: { type: 'string', description: 'Stake UTxO Transaction Hash' },
                        index: { type: 'number', description: 'Stake UTxO Index' }
                    },
                    required: ['txHash', 'index'],
                    description: 'Stake UTxO'
                },
                delta: { type: 'string', description: 'Amount to add or subtract from stake' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'User Wallet UTxOs'
                }
            },
            required: ['address', 'communityId', 'utxo', 'delta', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /updateStake")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => updateStakeEndpoint(prisma, body))
        console.log(resp)
        return resp.tx
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/destroyStake', {
    schema: {
        body: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'User CIP-30 Address' },
                communityId: { type: 'string', description: 'Summon Platform CommunityId' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Stake UTxO Transaction Hash' },
                            index: { type: 'number', description: 'Stake UTxO Index' }
                        },
                        required: ['txHash', 'index']
                    },
                    description: 'Stake UTxOs'
                },
                uutxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'User Wallet UTxOs'
                }
            },
            required: ['address', 'communityId', 'utxos', 'uutxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /destroyStake")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => destroyStakeEndpoint(prisma, body))
        console.log(resp)
        return resp.tx
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/cosignProposal', {
    schema: {
        body: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'User CIP-30 Address' },
                communityId: { type: 'string', description: 'Summon Platform CommunityId' },
                utxo: {
                    type: 'object',
                    properties: {
                        txHash: { type: 'string', description: 'Stake UTxO Transaction Hash' },
                        index: { type: 'number', description: 'Stake UTxO Index' }
                    },
                    required: ['txHash', 'index'],
                    description: 'Stake UTxO'
                },
                propId: { type: 'string', description: 'Proposal Id' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'User Wallet UTxOs'
                }
            },
            required: ['address', 'communityId', 'utxo', 'propId', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /cosignProposal")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => cosignEndpoint(prisma, body))
        console.log(resp)
        return resp.tx
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/delegateStake', {
    schema: {
        body: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'User CIP-30 Address' },
                communityId: { type: 'string', description: 'Summon Platform CommunityId' },
                utxo: {
                    type: 'object',
                    properties: {
                        txHash: { type: 'string', description: 'Stake UTxO Transaction Hash' },
                        index: { type: 'number', description: 'Stake UTxO Index' }
                    },
                    required: ['txHash', 'index'],
                    description: 'Stake UTxO'
                },
                delegateTo: { type: 'string', description: 'Address to delegate to' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'User Wallet UTxOs'
                }
            },
            required: ['address', 'communityId', 'utxo', 'delegateTo', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /delegateStake")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => delegateStakeEndpoint(prisma, body))
        console.log(resp)
        return resp.tx
    } catch (e) {
        // console.log(e)
        throw e
    }
})

server.post('/applyVote', {
    schema: {
        body: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'User CIP-30 Address' },
                communityId: { type: 'string', description: 'Summon Platform CommunityId' },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Stake UTxO Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Stake UTxO Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'Stake UTxOs'
                },
                propId: { type: 'string', description: 'Proposal Id' },
                voteResult: { type: 'number', description: 'Vote result' },
                uutxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'User Wallet UTxOs'
                }
            },
            required: ['address', 'communityId', 'utxos', 'propId', 'voteResult', 'uutxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /applyVote")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => voteEndpoint(prisma, body))
        console.log(resp)
        return resp.tx
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/retractVote', {
    schema: {
        body: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'User CIP-30 Address' },
                communityId: { type: 'string', description: 'Summon Platform CommunityId' },
                utxo: {
                    type: 'object',
                    properties: {
                        txHash: { type: 'string', description: 'Stake UTxO Transaction Hash' },
                        index: { type: 'number', description: 'Stake UTxO Index' }
                    },
                    required: ['txHash', 'index'],
                    description: 'Stake UTxO'
                },
                propLock: {
                    type: 'object',
                    properties: {
                        propId: { type: 'string', description: 'Proposal Id' },
                        propLock: { type: 'string', description: 'Proposal Lock' }
                    },
                    required: ['propId', 'propLock'],
                    description: 'Proposal Lock'
                },
                utxos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string', description: 'Transaction Hash' },
                            outputIndex: { type: 'number', description: 'Output Index' }
                        },
                        required: ['txHash', 'outputIndex']
                    },
                    description: 'User Wallet UTxOs'
                }
            },
            required: ['address', 'communityId', 'utxo', 'propLock', 'utxos'],
            tags: ['dao-service'],
            security: [
                {
                    bearerAuth: ['update:public', 'platform:full'], // Define the required scopes here
                },
            ]
        },
        response: {
            200: {
                description: 'Full transaction ready for signature.',
                type: 'string',
            }
        },
    },
}, async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /retractVote")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        console.log(`Entered /retractVote`)
        const body: any = request.body
        const resp = await limiter.schedule(() => revokeVoteEndpoint(prisma, body))
        console.log(resp)
        return resp.tx
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/governorUpdate', async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /governorUpdate")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => mutateGovernorEndpoint(prisma, body))
        console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})

server.post('/treasurySpend', async (request: AuthenticatedRequest, reply) => {
    try {
        handleScopes(request, ['update:public', 'platform:full'])
        console.log("Entered /treasurySpend")
        const userId = request.user?.user_id
        if (!userId) throw "The user is not valid"
        const body: any = request.body
        const resp = await limiter.schedule(() => spendFromTreasuryEndpoint(prisma, body))
        console.log(resp)
        return resp
    } catch (e) {
        console.log(e)
        throw e
    }
})