.PHONY: help deploy-q2 deploy-q2-sjekk

# Målene tar ingen ref. make henter variabler fra miljøet, MAKEFLAGS og
# MAKEFILES, og ekspanderer dem; ingen vakt her kan skille en ment REF fra en
# glemt eksport. En REF med innhold, uansett kilde, stopper derfor all kjøring.
# `$(value …)` ekspanderer ikke verdien.
ifneq ($(value REF),)
$(error make-målene deployer alltid tuppen av muninn main og tar ingen REF. For en bestemt ref: scripts/deploy-q2.sh <tag|sha>. Er REF eksportert fra annet arbeid: unset REF)
endif

help:
	@echo "make deploy-q2        deployer tuppen av muninn main til q2"
	@echo "make deploy-q2-sjekk  bare forhåndssjekkene, starter ingen workflow"
	@echo "scripts/deploy-q2.sh <tag|sha>            deployer en bestemt ref"
	@echo "DRY_RUN=1 scripts/deploy-q2.sh <tag|sha>  sjekker en bestemt ref"

deploy-q2:
	@scripts/deploy-q2.sh

deploy-q2-sjekk:
	@DRY_RUN=1 scripts/deploy-q2.sh
