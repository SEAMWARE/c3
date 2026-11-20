//
// FILE            assist.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// AI Assist - which engine answers /api/assist...:
//
//   assistLocal.c    Claude Code on the login of whoever runs c3 (C3_DEV=1) - the development engine: each
//                    tester on their own subscription or Seamware seat, nothing billed per question
//   assistService.c  the Coraine Assistant service with an AI Assist token ($C3_ASSIST_URL) - for paying
//                    customers, later
//
// The local engine when it is there, else the service, else neither: the page shows why.
//
#include <stdbool.h>                             // bool

#include "c3.h"



static enum { EngineNone, EngineLocal, EngineService } engine = EngineNone;



// -----------------------------------------------------------------------------
//
// assistInit -
//
void assistInit(void)
{
  if (assistLocalInit() == true)
    engine = EngineLocal;
  else if (assistServiceInit() == true)
    engine = EngineService;
}



// -----------------------------------------------------------------------------
//
// assistRequest - the engine's; with neither, the local engine's "not available" (it says why)
//
void assistRequest(CorHttpConn* connP, const char* path)
{
  if (engine == EngineService)
    assistServiceRequest(connP, path);
  else
    assistLocalRequest(connP, path);
}
